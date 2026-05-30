from __future__ import annotations

import json
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from werkzeug.exceptions import RequestEntityTooLarge
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Flask, jsonify, request, send_from_directory
from groq import APIConnectionError, APIStatusError, APITimeoutError, Groq

ROOT = Path(__file__).resolve().parent
REQUEST_BACKOFF_MESSAGE = "Try again in 5 minutes, too many messages are being sent right now."
DEFAULT_RATE_LIMIT = 200
DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 86400
DEFAULT_RATE_LIMIT_TIMEZONE = "America/New_York"
ANONYMOUS_DAILY_RATE_LIMIT = 10
ANONYMOUS_DAILY_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60
FAST_MODE_RATE_LIMIT_COST = 3
MAX_PROFILE_PICTURE_DATA_URL_LENGTH = 750000
MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
MAX_CHAT_MESSAGE_CONTENT_LENGTH = 24000
MAX_CHAT_MESSAGES_PER_CHAT = 1000
MAX_ACCOUNT_CHATS = 10
SESSION_COOKIE_NAME = "aether_session"
SESSION_LIFETIME_DAYS = 30
PASSWORD_HASH_ITERATIONS = 260000
OWNER_ADMIN_USERNAME = os.getenv("AETHER_OWNER_USERNAME", "adamsrealm1").strip().lower() or "adamsrealm1"
AUTH_RATE_LIMIT = 40
AUTH_RATE_LIMIT_WINDOW_SECONDS = 15 * 60
SAFETY_SCAN_RATE_LIMIT = 600
SAFETY_SCAN_WINDOW_SECONDS = 60 * 60
SAFETY_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.72
HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify"
MESSAGE_CAPTCHA_LIMIT = 5
MESSAGE_CAPTCHA_WINDOW_SECONDS = 35
MESSAGE_CAPTCHA_PASS_SECONDS = 5 * 60
RATE_LIMITS: dict[str, dict] = {}
MESSAGE_CAPTCHA_PASSES: dict[str, datetime] = {}
DB_INITIALIZED = False
app = Flask(__name__, static_folder=str(ROOT), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BODY_BYTES
PROFANITY_TOKEN_HASHES = {
    "3272efda", "92a4ff90", "81602170", "91b887d3", "82405e59",
    "dbafbd1d", "e6774d4a", "8814611d", "893dcdb6", "a856eb33",
    "cf5447f4", "6cd5e87b", "b99bf986", "d9eb56dd", "a4705559",
    "243c4bae", "18a40a3d", "6537d094", "d7337605", "d95c3b1f",
}
PROFANITY_TOKEN_RE = re.compile(r"[A-Za-z0-9_@$!]+")
PROFANITY_CHAR_MAP = str.maketrans({
    "@": "a",
    "$": "s",
    "!": "i",
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
})
WEATHER_CODES = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "rime fog",
    51: "light drizzle",
    53: "moderate drizzle",
    55: "dense drizzle",
    61: "slight rain",
    63: "moderate rain",
    65: "heavy rain",
    71: "slight snow",
    73: "moderate snow",
    75: "heavy snow",
    80: "slight rain showers",
    81: "moderate rain showers",
    82: "violent rain showers",
    95: "thunderstorm",
    96: "thunderstorm with slight hail",
    99: "thunderstorm with heavy hail",
}


def fnv1a_32(value: str) -> str:
    digest = 2166136261
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = (digest * 16777619) & 0xFFFFFFFF
    return f"{digest:08x}"


def normalize_profanity_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower().translate(PROFANITY_CHAR_MAP))


def profanity_token_mask(value: str) -> str:
    return "*" * max(4, len(value))


def mask_profanity(message: object) -> str:
    text = str(message or "")

    def replace(match: re.Match) -> str:
        normalized = normalize_profanity_token(match.group(0))
        if normalized and fnv1a_32(normalized) in PROFANITY_TOKEN_HASHES:
            return profanity_token_mask(match.group(0))
        return match.group(0)

    return PROFANITY_TOKEN_RE.sub(replace, text)


def contains_profanity(message: object) -> bool:
    text = str(message or "")
    return mask_profanity(text) != text


def mask_chat_profanity(chat: list) -> list:
    sanitized = []
    for item in chat:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        next_item["content"] = mask_profanity(next_item.get("content", ""))
        sanitized.append(next_item)
    return sanitized


def safety_lock_reason(message: str) -> str:
    return ""

def rate_limit_key(ip_address: str | None = None, account_id: object = None) -> str:
    account_value = str(account_id or "").strip()
    if account_value:
        return f"account:{account_value[:120]}"
    cleaned = str(ip_address or "unknown").strip() or "unknown"
    return f"anonymous:{cleaned[:120]}"


def request_rate_limit_settings(account_id: object = None) -> dict:
    if str(account_id or "").strip():
        return rate_limit_settings()
    return {
        "limit": ANONYMOUS_DAILY_RATE_LIMIT,
        "windowSeconds": ANONYMOUS_DAILY_RATE_LIMIT_WINDOW_SECONDS,
    }


def global_rate_limit_reset_at(now: datetime, window_seconds: int) -> datetime:
    window_seconds = max(1, int(window_seconds or DEFAULT_RATE_LIMIT_WINDOW_SECONDS))
    local_now = now.astimezone(rate_limit_timezone(now))
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    seconds_since_midnight = int((local_now - local_midnight).total_seconds())
    seconds_until_reset = window_seconds - (seconds_since_midnight % window_seconds)
    if seconds_until_reset <= 0:
        seconds_until_reset = window_seconds
    return (local_now + timedelta(seconds=seconds_until_reset)).astimezone(timezone.utc).replace(microsecond=0)


def rate_limit_timezone(now: datetime | None = None):
    try:
        return ZoneInfo(os.getenv("AETHER_RATE_LIMIT_TIMEZONE", DEFAULT_RATE_LIMIT_TIMEZONE).strip() or DEFAULT_RATE_LIMIT_TIMEZONE)
    except ZoneInfoNotFoundError:
        if (os.getenv("AETHER_RATE_LIMIT_TIMEZONE", DEFAULT_RATE_LIMIT_TIMEZONE).strip() or DEFAULT_RATE_LIMIT_TIMEZONE) == DEFAULT_RATE_LIMIT_TIMEZONE:
            return timezone(eastern_utc_offset(now or utc_now()), DEFAULT_RATE_LIMIT_TIMEZONE)
        return timezone.utc


def eastern_utc_offset(now: datetime) -> timedelta:
    utc_now_value = now.astimezone(timezone.utc)
    year = utc_now_value.year
    dst_start = eastern_dst_transition_utc(year, 3, 2, -5)
    dst_end = eastern_dst_transition_utc(year, 11, 1, -4)
    return timedelta(hours=-4 if dst_start <= utc_now_value < dst_end else -5)


def eastern_dst_transition_utc(year: int, month: int, occurrence: int, offset_before_hours: int) -> datetime:
    day = 1
    matches = 0
    while True:
        candidate = datetime(year, month, day, 2, 0)
        if candidate.weekday() == 6:
            matches += 1
            if matches == occurrence:
                local_before_transition = candidate.replace(tzinfo=timezone(timedelta(hours=offset_before_hours)))
                return local_before_transition.astimezone(timezone.utc)
        day += 1


def rate_limit_status(ip_address: str | None = None, account_id: object = None) -> dict:
    settings = request_rate_limit_settings(account_id)
    limit = int(settings["limit"])
    window_seconds = int(settings["windowSeconds"])
    now = utc_now()
    reset_at = global_rate_limit_reset_at(now, window_seconds)
    key = rate_limit_key(ip_address, account_id)
    bucket = load_rate_limit_bucket(key)
    if not bucket or bucket["resetAt"] <= now or int(bucket.get("windowSeconds", 0)) != window_seconds or bucket["resetAt"] != reset_at:
        bucket = {
            "count": 0,
            "resetAt": reset_at,
            "windowSeconds": window_seconds,
        }
        save_rate_limit_bucket(key, bucket["count"], bucket["resetAt"], window_seconds)

    used = int(bucket["count"])
    remaining = max(0, limit - used)
    reset_in = max(0, int((bucket["resetAt"] - now).total_seconds()))
    return {
        "limit": limit,
        "used": used,
        "remaining": remaining,
        "percentUsed": round((used / limit) * 100) if limit else 0,
        "resetAt": bucket["resetAt"].isoformat(),
        "resetInSeconds": reset_in,
        "windowSeconds": window_seconds,
    }


def consume_rate_limit(ip_address: str, account_id: object = None, cost: int = 1) -> dict:
    cost = max(1, int(cost or 1))
    status = rate_limit_status(ip_address, account_id)
    if status["remaining"] < cost:
        return {"allowed": False, "rateLimit": status}

    key = rate_limit_key(ip_address, account_id)
    used = int(status["used"]) + cost
    save_rate_limit_bucket(key, used, parse_utc(status["resetAt"]), int(status["windowSeconds"]))
    return {"allowed": True, "rateLimit": rate_limit_status(ip_address, account_id)}


def refund_rate_limit(ip_address: str, account_id: object = None) -> None:
    key = rate_limit_key(ip_address, account_id)
    bucket = load_rate_limit_bucket(key)
    if not bucket:
        return
    save_rate_limit_bucket(key, max(0, int(bucket.get("count", 0)) - 1), bucket["resetAt"], int(bucket["windowSeconds"]))


def bucket_status(key: str, limit: int, window_seconds: int) -> dict:
    limit = max(1, int(limit))
    window_seconds = max(1, int(window_seconds))
    now = utc_now()
    reset_at = global_rate_limit_reset_at(now, window_seconds)
    bucket = load_rate_limit_bucket(key)
    if not bucket or bucket["resetAt"] <= now or int(bucket.get("windowSeconds", 0)) != window_seconds or bucket["resetAt"] != reset_at:
        bucket = {"count": 0, "resetAt": reset_at, "windowSeconds": window_seconds}
        save_rate_limit_bucket(key, 0, reset_at, window_seconds)
    used = int(bucket["count"])
    return {
        "limit": limit,
        "used": used,
        "remaining": max(0, limit - used),
        "resetAt": bucket["resetAt"].isoformat(),
        "windowSeconds": window_seconds,
    }


def consume_bucket_limit(key: str, limit: int, window_seconds: int) -> dict:
    status = bucket_status(key, limit, window_seconds)
    if status["remaining"] <= 0:
        return {"allowed": False, "rateLimit": status}
    used = int(status["used"]) + 1
    save_rate_limit_bucket(key, used, parse_utc(status["resetAt"]), int(status["windowSeconds"]))
    return {"allowed": True, "rateLimit": bucket_status(key, limit, window_seconds)}


def consume_auth_rate_limit(ip_address: str) -> dict:
    return consume_bucket_limit(f"security:auth:{str(ip_address or 'unknown')[:120]}", AUTH_RATE_LIMIT, AUTH_RATE_LIMIT_WINDOW_SECONDS)


def safety_scan_rate_limit_key(ip_address: str, account_id: object = None) -> str:
    return f"security:safety:{rate_limit_key(ip_address, account_id)}"


def consume_safety_scan_rate_limit(ip_address: str, account_id: object = None) -> dict:
    return consume_bucket_limit(
        safety_scan_rate_limit_key(ip_address, account_id),
        SAFETY_SCAN_RATE_LIMIT,
        SAFETY_SCAN_WINDOW_SECONDS,
    )


def bind_rate_limit_buckets(source_key: str, target_key: str) -> None:
    if not source_key or not target_key or source_key == target_key:
        return
    source = load_rate_limit_bucket(source_key)
    if not source:
        return
    target = load_rate_limit_bucket(target_key)
    if target and target["resetAt"] == source["resetAt"] and int(target["windowSeconds"]) == int(source["windowSeconds"]):
        next_count = max(int(target.get("count", 0)), int(source.get("count", 0)))
    else:
        next_count = int(source.get("count", 0))
    save_rate_limit_bucket(target_key, next_count, source["resetAt"], int(source["windowSeconds"]))


def bind_anonymous_rate_limit_to_account(ip_address: str, account_id: object) -> None:
    bind_rate_limit_buckets(rate_limit_key(ip_address), rate_limit_key(ip_address, account_id))
    bind_rate_limit_buckets(safety_scan_rate_limit_key(ip_address), safety_scan_rate_limit_key(ip_address, account_id))


def bind_account_rate_limit_to_ip(ip_address: str, account_id: object) -> None:
    bind_rate_limit_buckets(rate_limit_key(ip_address, account_id), rate_limit_key(ip_address))
    bind_rate_limit_buckets(safety_scan_rate_limit_key(ip_address, account_id), safety_scan_rate_limit_key(ip_address))


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def utc_now() -> datetime:
    return datetime.now(timezone.utc) 


def utc_iso() -> str:
    return utc_now().isoformat()


def mysql_configured() -> bool:
    return bool(
        os.getenv("DB_HOST")
        and os.getenv("DB_NAME")
        and (os.getenv("DB_USERNAME") or os.getenv("DB_USER"))
    )


def database_provider() -> str:
    return "mysql" if mysql_configured() else "sqlite"


def database_summary() -> dict:
    return {"provider": database_provider(), "ready": DB_INITIALIZED}


def default_rate_limit_status(account_id: object = None) -> dict:
    try:
        settings = request_rate_limit_settings(account_id)
    except Exception:
        settings = {
            "limit": ANONYMOUS_DAILY_RATE_LIMIT if not str(account_id or "").strip() else DEFAULT_RATE_LIMIT,
            "windowSeconds": ANONYMOUS_DAILY_RATE_LIMIT_WINDOW_SECONDS if not str(account_id or "").strip() else DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
        }
    limit = int(settings["limit"])
    window_seconds = int(settings["windowSeconds"])
    reset_at = global_rate_limit_reset_at(utc_now(), window_seconds)
    return {
        "limit": limit,
        "used": 0,
        "remaining": limit,
        "percentUsed": 0,
        "resetAt": reset_at.isoformat(),
        "resetInSeconds": max(0, int((reset_at - utc_now()).total_seconds())),
        "windowSeconds": window_seconds,
    }


def db_placeholder() -> str:
    return "%s" if database_provider() == "mysql" else "?"


def sqlite_database_path() -> Path:
    configured = os.getenv("AETHER_SQLITE_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()

    candidates = [
        ROOT / "aether_admin.sqlite3",
        Path(tempfile.gettempdir()) / "aether_admin.sqlite3",
    ]
    for path in candidates:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path.parent / ".aether_write_test", "w", encoding="utf-8") as handle:
                handle.write("ok")
            (path.parent / ".aether_write_test").unlink(missing_ok=True)
            return path
        except Exception:
            continue
    return Path(tempfile.gettempdir()) / "aether_admin.sqlite3"


def db_connect():
    if database_provider() == "mysql":
        import pymysql # type: ignore

        return pymysql.connect(
            host=os.getenv("DB_HOST", ""),
            port=int(os.getenv("DB_PORT", "3306")),
            user=os.getenv("DB_USERNAME") or os.getenv("DB_USER") or "",
            password=os.getenv("DB_PASSWORD", ""),
            database=os.getenv("DB_NAME", ""),
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
            charset="utf8mb4",
        )

    connection = sqlite3.connect(sqlite_database_path())
    connection.row_factory = sqlite3.Row
    return connection


def db_execute_raw(sql: str, params: tuple = (), fetch: bool = False) -> list[dict]:
    connection = db_connect()
    try:
        cursor = connection.cursor()
        cursor.execute(sql, params)
        rows = cursor.fetchall() if fetch else []
        if database_provider() == "sqlite":
            connection.commit()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def db_table_columns(table_name: str) -> set[str]:
    if database_provider() == "mysql":
        rows = db_execute_raw(f"SHOW COLUMNS FROM {table_name}", fetch=True)
        return {str(row.get("Field") or "").lower() for row in rows}
    rows = db_execute_raw(f"PRAGMA table_info({table_name})", fetch=True)
    return {str(row.get("name") or "").lower() for row in rows}


def ensure_banned_ip_columns() -> None:
    columns = db_table_columns("banned_ips")
    if "username" not in columns:
        definition = "VARCHAR(32)" if database_provider() == "mysql" else "TEXT"
        db_execute_raw(f"ALTER TABLE banned_ips ADD COLUMN username {definition}")
    if "source_message" not in columns:
        db_execute_raw("ALTER TABLE banned_ips ADD COLUMN source_message TEXT")


def ensure_account_columns() -> None:
    columns = db_table_columns("accounts")
    if "verified" not in columns:
        definition = "TINYINT(1) NOT NULL DEFAULT 0" if database_provider() == "mysql" else "INTEGER NOT NULL DEFAULT 0"
        db_execute_raw(f"ALTER TABLE accounts ADD COLUMN verified {definition}")


def migrate_username_ip_bans_to_account_bans() -> None:
    placeholder = db_placeholder()
    rows = db_execute_raw(
        "SELECT ip_address, username, reason, source_message, created_at FROM banned_ips",
        fetch=True,
    )
    for row in rows:
        raw_username = str(row.get("username") or "").strip()
        if not raw_username:
            reason_match = re.match(r"\s*(?:User ban:\s*|Blocked attempt by\s+)([A-Za-z0-9_.-]{3,24})\b", str(row.get("reason") or ""))
            raw_username = reason_match.group(1) if reason_match else ""
        username_lc = normalize_username(raw_username).lower()
        if not username_lc:
            continue
        accounts = db_execute_raw(
            f"SELECT id, username FROM accounts WHERE username_lc = {placeholder}",
            (username_lc,),
            fetch=True,
        )
        if not accounts:
            continue
        account = accounts[0]
        if database_provider() == "mysql":
            db_execute_raw(
                (
                    "INSERT INTO banned_accounts (account_id, username, reason, source_message, created_at) "
                    "VALUES (%s, %s, %s, %s, %s) ON DUPLICATE KEY UPDATE "
                    "username = VALUES(username), reason = VALUES(reason), source_message = VALUES(source_message)"
                ),
                (
                    account.get("id"),
                    account.get("username") or raw_username,
                    row.get("reason") or "",
                    row.get("source_message") or "",
                    row.get("created_at") or utc_iso(),
                ),
            )
        else:
            db_execute_raw(
                "INSERT OR REPLACE INTO banned_accounts (account_id, username, reason, source_message, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    account.get("id"),
                    account.get("username") or raw_username,
                    row.get("reason") or "",
                    row.get("source_message") or "",
                    row.get("created_at") or utc_iso(),
                ),
            )
        db_execute_raw(f"DELETE FROM banned_ips WHERE ip_address = {placeholder}", (row.get("ip_address"),))


def ensure_admin_db() -> None:
    global DB_INITIALIZED
    if DB_INITIALIZED:
        return

    if database_provider() == "mysql":
        statements = [
            """
            CREATE TABLE IF NOT EXISTS admin_settings (
              name VARCHAR(80) PRIMARY KEY,
              value TEXT NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS request_events (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              created_at VARCHAR(40) NOT NULL,
              ip_address VARCHAR(80) NOT NULL,
              kind VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS banned_ips (
              ip_address VARCHAR(80) PRIMARY KEY,
              username VARCHAR(32),
              reason TEXT,
              source_message TEXT,
              created_at VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS banned_accounts (
              account_id BIGINT PRIMARY KEY,
              username VARCHAR(32),
              reason TEXT,
              source_message TEXT,
              created_at VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS blocked_attempts (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              created_at VARCHAR(40) NOT NULL,
              ip_address VARCHAR(80) NOT NULL,
              message TEXT NOT NULL,
              context_json TEXT NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS accounts (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              username VARCHAR(32) NOT NULL,
              username_lc VARCHAR(32) NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              created_at VARCHAR(40) NOT NULL,
              updated_at VARCHAR(40) NOT NULL,
              last_login_at VARCHAR(40),
              verified TINYINT(1) NOT NULL DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS account_sessions (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              account_id BIGINT NOT NULL,
              token_hash VARCHAR(128) NOT NULL UNIQUE,
              created_at VARCHAR(40) NOT NULL,
              expires_at VARCHAR(40) NOT NULL,
              last_seen_at VARCHAR(40) NOT NULL,
              ip_address VARCHAR(80),
              user_agent VARCHAR(255)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS account_profile_pictures (
              account_id BIGINT PRIMARY KEY,
              approved_data_url MEDIUMTEXT,
              approved_at VARCHAR(40),
              pending_data_url MEDIUMTEXT,
              pending_at VARCHAR(40)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS account_chats (
              account_id BIGINT PRIMARY KEY,
              chats_json LONGTEXT NOT NULL,
              active_chat_id VARCHAR(120),
              updated_at VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS account_admins (
              account_id BIGINT PRIMARY KEY,
              granted_by BIGINT,
              created_at VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS rate_limit_buckets (
              bucket_key VARCHAR(160) PRIMARY KEY,
              count INT NOT NULL,
              reset_at VARCHAR(40) NOT NULL,
              window_seconds INT NOT NULL,
              updated_at VARCHAR(40) NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            """
            CREATE TABLE IF NOT EXISTS message_reports (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              created_at VARCHAR(40) NOT NULL,
              reporter_account_id BIGINT,
              reporter_client_id VARCHAR(120),
              reporter_username VARCHAR(32),
              reporter_ip VARCHAR(80),
              chat_id VARCHAR(120),
              chat_title VARCHAR(120),
              message_id VARCHAR(120) NOT NULL,
              message_role VARCHAR(20) NOT NULL,
              message_content TEXT NOT NULL,
              report_note TEXT,
              context_json TEXT NOT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'open',
              resolved_at VARCHAR(40),
              resolved_by_account_id BIGINT,
              notification_seen_at VARCHAR(40)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            """,
            "CREATE INDEX idx_request_events_created_at ON request_events (created_at)",
            "CREATE INDEX idx_blocked_attempts_created_at ON blocked_attempts (created_at)",
            "CREATE INDEX idx_message_reports_status_created_at ON message_reports (status, created_at)",
            "CREATE INDEX idx_message_reports_reporter_account ON message_reports (reporter_account_id, status, notification_seen_at)",
            "CREATE INDEX idx_message_reports_reporter_client ON message_reports (reporter_client_id, status, notification_seen_at)",
        ]
    else:
        statements = [
            """
            CREATE TABLE IF NOT EXISTS admin_settings (
              name TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS request_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,
              ip_address TEXT NOT NULL,
              kind TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS banned_ips (
              ip_address TEXT PRIMARY KEY,
              username TEXT,
              reason TEXT,
              source_message TEXT,
              created_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS banned_accounts (
              account_id INTEGER PRIMARY KEY,
              username TEXT,
              reason TEXT,
              source_message TEXT,
              created_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS blocked_attempts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,
              ip_address TEXT NOT NULL,
              message TEXT NOT NULL,
              context_json TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL,
              username_lc TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_login_at TEXT,
              verified INTEGER NOT NULL DEFAULT 0
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS account_sessions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              account_id INTEGER NOT NULL,
              token_hash TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              ip_address TEXT,
              user_agent TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS account_profile_pictures (
              account_id INTEGER PRIMARY KEY,
              approved_data_url TEXT,
              approved_at TEXT,
              pending_data_url TEXT,
              pending_at TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS account_chats (
              account_id INTEGER PRIMARY KEY,
              chats_json TEXT NOT NULL,
              active_chat_id TEXT,
              updated_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS account_admins (
              account_id INTEGER PRIMARY KEY,
              granted_by INTEGER,
              created_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS rate_limit_buckets (
              bucket_key TEXT PRIMARY KEY,
              count INTEGER NOT NULL,
              reset_at TEXT NOT NULL,
              window_seconds INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS message_reports (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,
              reporter_account_id INTEGER,
              reporter_client_id TEXT,
              reporter_username TEXT,
              reporter_ip TEXT,
              chat_id TEXT,
              chat_title TEXT,
              message_id TEXT NOT NULL,
              message_role TEXT NOT NULL,
              message_content TEXT NOT NULL,
              report_note TEXT,
              context_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'open',
              resolved_at TEXT,
              resolved_by_account_id INTEGER,
              notification_seen_at TEXT
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events (created_at)",
            "CREATE INDEX IF NOT EXISTS idx_blocked_attempts_created_at ON blocked_attempts (created_at)",
            "CREATE INDEX IF NOT EXISTS idx_message_reports_status_created_at ON message_reports (status, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_message_reports_reporter_account ON message_reports (reporter_account_id, status, notification_seen_at)",
            "CREATE INDEX IF NOT EXISTS idx_message_reports_reporter_client ON message_reports (reporter_client_id, status, notification_seen_at)",
        ]

    for statement in statements:
        try:
            db_execute_raw(statement)
        except Exception:
            if "CREATE INDEX" not in statement:
                raise

    ensure_banned_ip_columns()
    ensure_account_columns()
    migrate_username_ip_bans_to_account_bans()
    DB_INITIALIZED = True
    if get_admin_setting("aether_available") is None:
        set_admin_setting("aether_available", "1")
    if get_admin_setting("rate_limit") is None:
        set_admin_setting("rate_limit", str(DEFAULT_RATE_LIMIT))
    if get_admin_setting("rate_limit_window_seconds") is None:
        set_admin_setting("rate_limit_window_seconds", str(DEFAULT_RATE_LIMIT_WINDOW_SECONDS))


def db_query(sql: str, params: tuple = ()) -> list[dict]:
    ensure_admin_db()
    return db_execute_raw(sql, params, fetch=True)


def db_execute(sql: str, params: tuple = ()) -> None:
    ensure_admin_db()
    db_execute_raw(sql, params, fetch=False)


def get_admin_setting(name: str) -> str | None:
    placeholder = db_placeholder()
    rows = db_execute_raw(f"SELECT value FROM admin_settings WHERE name = {placeholder}", (name,), fetch=True)
    return str(rows[0]["value"]) if rows else None


def set_admin_setting(name: str, value: str) -> None:
    if database_provider() == "mysql":
        db_execute_raw(
            "INSERT INTO admin_settings (name, value) VALUES (%s, %s) ON DUPLICATE KEY UPDATE value = VALUES(value)",
            (name, value),
        )
    else:
        db_execute_raw("INSERT OR REPLACE INTO admin_settings (name, value) VALUES (?, ?)", (name, value))


def is_aether_available() -> bool:
    ensure_admin_db()
    return get_admin_setting("aether_available") != "0"


def set_aether_available(available: bool) -> None:
    ensure_admin_db()
    set_admin_setting("aether_available", "1" if available else "0")


def bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    return max(minimum, min(maximum, number))


def rate_limit_settings() -> dict:
    ensure_admin_db()
    limit = bounded_int(get_admin_setting("rate_limit"), DEFAULT_RATE_LIMIT, 1, 100000)
    window_seconds = bounded_int(
        get_admin_setting("rate_limit_window_seconds"),
        DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
        1,
        86400,
    )
    return {"limit": limit, "windowSeconds": window_seconds}


def set_rate_limit_settings(limit: object, window_seconds: object) -> None:
    limit_value = bounded_int(limit, DEFAULT_RATE_LIMIT, 1, 100000)
    window_value = bounded_int(window_seconds, DEFAULT_RATE_LIMIT_WINDOW_SECONDS, 1, 86400)
    ensure_admin_db()
    set_admin_setting("rate_limit", str(limit_value))
    set_admin_setting("rate_limit_window_seconds", str(window_value))
    reset_all_rate_limits()


def reset_all_rate_limits() -> None:
    RATE_LIMITS.clear()
    try:
        db_execute("DELETE FROM rate_limit_buckets")
    except Exception:
        pass


def load_rate_limit_bucket(key: str) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(
        f"SELECT bucket_key, count, reset_at, window_seconds FROM rate_limit_buckets WHERE bucket_key = {placeholder}",
        (key,),
    )
    if not rows:
        return None
    row = rows[0]
    return {
        "count": int(row.get("count") or 0),
        "resetAt": parse_utc(row.get("reset_at")),
        "windowSeconds": int(row.get("window_seconds") or DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
    }


def save_rate_limit_bucket(key: str, count: int, reset_at: datetime, window_seconds: int) -> None:
    now = utc_iso()
    reset_value = reset_at.astimezone(timezone.utc).isoformat()
    count = max(0, int(count))
    window_seconds = max(1, int(window_seconds or DEFAULT_RATE_LIMIT_WINDOW_SECONDS))
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO rate_limit_buckets (bucket_key, count, reset_at, window_seconds, updated_at) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE count = VALUES(count), reset_at = VALUES(reset_at), "
                "window_seconds = VALUES(window_seconds), updated_at = VALUES(updated_at)"
            ),
            (key, count, reset_value, window_seconds, now),
        )
    else:
        db_execute(
            (
                "INSERT OR REPLACE INTO rate_limit_buckets "
                "(bucket_key, count, reset_at, window_seconds, updated_at) VALUES (?, ?, ?, ?, ?)"
            ),
            (key, count, reset_value, window_seconds, now),
        )


def parse_utc(value: object) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    try:
        return datetime.fromisoformat(str(value)).astimezone(timezone.utc)
    except Exception:
        return utc_now()


def record_request_event(ip_address: str, kind: str = "chat") -> None:
    placeholder = db_placeholder()
    db_execute(
        f"INSERT INTO request_events (created_at, ip_address, kind) VALUES ({placeholder}, {placeholder}, {placeholder})",
        (utc_iso(), ip_address[:80], kind[:40]),
    )


def safe_record_request_event(ip_address: str, kind: str = "chat") -> None:
    try:
        record_request_event(ip_address, kind)
    except Exception:
        pass


def recent_request_event_count(ip_address: str, kind: str = "chat", window_seconds: int = MESSAGE_CAPTCHA_WINDOW_SECONDS) -> int:
    placeholder = db_placeholder()
    since = (utc_now() - timedelta(seconds=max(1, int(window_seconds)))).isoformat()
    try:
        rows = db_query(
            f"SELECT COUNT(*) AS count FROM request_events WHERE ip_address = {placeholder} AND kind = {placeholder} AND created_at >= {placeholder}",
            ((ip_address or "")[:80], kind[:40], since),
        )
        return int(rows[0].get("count") or 0) if rows else 0
    except Exception:
        return 0


def message_captcha_key(ip_address: str, account_id: object = None) -> str:
    account_value = str(account_id or "").strip()
    if account_value:
        return f"account:{account_value[:120]}"
    return f"anonymous:{str(ip_address or 'unknown').strip()[:120]}"


def grant_message_captcha_pass(ip_address: str, account_id: object = None) -> None:
    MESSAGE_CAPTCHA_PASSES[message_captcha_key(ip_address, account_id)] = utc_now() + timedelta(seconds=MESSAGE_CAPTCHA_PASS_SECONDS)


def consume_message_captcha_pass(ip_address: str, account_id: object = None) -> bool:
    key = message_captcha_key(ip_address, account_id)
    expires_at = MESSAGE_CAPTCHA_PASSES.get(key)
    if not expires_at:
        return False
    if expires_at <= utc_now():
        MESSAGE_CAPTCHA_PASSES.pop(key, None)
        return False
    MESSAGE_CAPTCHA_PASSES.pop(key, None)
    return True


def message_captcha_required(ip_address: str, account_id: object = None) -> bool:
    return recent_request_event_count(ip_address, "chat", MESSAGE_CAPTCHA_WINDOW_SECONDS) >= MESSAGE_CAPTCHA_LIMIT


def request_counts() -> dict:
    since_day = utc_now() - timedelta(days=1)
    placeholder = db_placeholder()
    rows = db_query(f"SELECT created_at FROM request_events WHERE created_at >= {placeholder}", (since_day.isoformat(),))
    now = utc_now()
    counts = {"minute": 0, "hour": 0, "day": 0}
    for row in rows:
        created_at = parse_utc(row.get("created_at"))
        age = now - created_at
        if age <= timedelta(minutes=1):
            counts["minute"] += 1
        if age <= timedelta(hours=1):
            counts["hour"] += 1
        if age <= timedelta(days=1):
            counts["day"] += 1
    return counts


def public_ban_details(row: dict | None) -> dict:
    if not row:
        return {"banned": False}
    ban_type = row.get("ban_type") or ("account" if row.get("account_id") is not None else "ip")
    account = find_account_by_id(row.get("account_id")) if row.get("account_id") is not None else verified_account_for_username(row.get("username"))
    return {
        "banned": True,
        "banType": ban_type,
        "accountId": row.get("account_id"),
        "ipAddress": row.get("ip_address") or "",
        "username": row.get("username") or "",
        "isVerified": account_is_verified(account),
        "reason": row.get("reason") or "",
        "sourceMessage": row.get("source_message") or "",
        "createdAt": row.get("created_at"),
    }


def banned_ips() -> list[dict]:
    rows = db_query("SELECT ip_address, username, reason, source_message, created_at FROM banned_ips ORDER BY created_at DESC")
    bans = []
    for row in rows:
        account = verified_account_for_username(row.get("username"))
        bans.append({
            "banType": "ip",
            "ipAddress": row.get("ip_address"),
            "username": row.get("username") or "",
            "isVerified": account_is_verified(account),
            "reason": row.get("reason") or "",
            "sourceMessage": row.get("source_message") or "",
            "createdAt": row.get("created_at"),
        })
    return bans


def banned_accounts() -> list[dict]:
    rows = db_query("SELECT account_id, username, reason, source_message, created_at FROM banned_accounts ORDER BY created_at DESC")
    bans = []
    for row in rows:
        account = find_account_by_id(row.get("account_id"))
        bans.append({
            "banType": "account",
            "accountId": row.get("account_id"),
            "username": row.get("username") or "",
            "isVerified": account_is_verified(account),
            "reason": row.get("reason") or "",
            "sourceMessage": row.get("source_message") or "",
            "createdAt": row.get("created_at"),
        })
    return bans


def banned_ip_record(ip_address: str) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(
        f"SELECT 'ip' AS ban_type, ip_address, username, reason, source_message, created_at FROM banned_ips WHERE ip_address = {placeholder}",
        (str(ip_address or "")[:80],),
    )
    return rows[0] if rows else None


def banned_account_record(account_id: object) -> dict | None:
    account_id_value = str(account_id or "").strip()
    if not account_id_value:
        return None
    placeholder = db_placeholder()
    rows = db_query(
        f"SELECT 'account' AS ban_type, account_id, username, reason, source_message, created_at FROM banned_accounts WHERE account_id = {placeholder}",
        (account_id,),
    )
    return rows[0] if rows else None


def request_ban_record(ip_address: str, account: dict | None = None) -> dict | None:
    if account:
        account_ban = banned_account_record(account.get("id"))
        if account_ban:
            return account_ban
    return banned_ip_record(ip_address)


def banned_api_response(row: dict):
    return jsonify(
        {
            "error": "You are banned from Aether AI.",
            "banned": True,
            "ban": public_ban_details(row),
        }
    ), 403


def is_account_banned(account_id: object) -> bool:
    return bool(banned_account_record(account_id))


def verified_account_for_username(username: object) -> dict | None:
    normalized = normalize_username(username)
    return find_account_by_username(normalized) if normalized else None


def ban_ip(ip_address: str, reason: str = "", username: str = "", source_message: str = "") -> None:
    ip_address = ip_address.strip()[:80]
    if not ip_address:
        raise ValueError("IP address is required.")
    reason = reason.strip()[:500]
    username = normalize_username(username)[:32]
    source_message = str(source_message or "").strip()[:2000]
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO banned_ips (ip_address, username, reason, source_message, created_at) "
                "VALUES (%s, %s, %s, %s, %s) ON DUPLICATE KEY UPDATE "
                "username = VALUES(username), reason = VALUES(reason), source_message = VALUES(source_message)"
            ),
            (ip_address, username, reason, source_message, utc_iso()),
        )
    else:
        db_execute(
            "INSERT OR REPLACE INTO banned_ips (ip_address, username, reason, source_message, created_at) VALUES (?, ?, ?, ?, ?)",
            (ip_address, username, reason, source_message, utc_iso()),
        )


def ban_account(account_id: object, username: str = "", reason: str = "", source_message: str = "") -> None:
    account_id_value = str(account_id or "").strip()
    if not account_id_value:
        raise ValueError("Account is required.")
    account = find_account_by_id(account_id)
    if not account:
        raise ValueError("Account was not found.")
    if is_owner_account(account):
        raise ValueError("The owner admin account cannot be banned.")
    username = normalize_username(username or account.get("username"))[:32]
    reason = str(reason or "").strip()[:500]
    source_message = str(source_message or "").strip()[:2000]
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO banned_accounts (account_id, username, reason, source_message, created_at) "
                "VALUES (%s, %s, %s, %s, %s) ON DUPLICATE KEY UPDATE "
                "username = VALUES(username), reason = VALUES(reason), source_message = VALUES(source_message)"
            ),
            (account.get("id"), username, reason, source_message, utc_iso()),
        )
    else:
        db_execute(
            "INSERT OR REPLACE INTO banned_accounts (account_id, username, reason, source_message, created_at) VALUES (?, ?, ?, ?, ?)",
            (account.get("id"), username, reason, source_message, utc_iso()),
        )


def ban_account_by_username(username: object, reason: str = "", source_message: str = "") -> tuple[object, str]:
    username_lc = normalize_username(username)
    if not username_lc:
        raise ValueError("Username is required.")
    account = find_account_by_username(username_lc)
    if not account:
        raise ValueError("Account was not found.")
    ban_account(account.get("id"), account.get("username") or username_lc, reason, source_message)
    return account.get("id"), str(account.get("username") or username_lc)


def unban_account(account_id: object) -> None:
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM banned_accounts WHERE account_id = {placeholder}", (account_id,))


def unban_ip(ip_address: str) -> None:
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM banned_ips WHERE ip_address = {placeholder}", (ip_address.strip()[:80],))


def last_user_messages(chat: list[dict], current_message: str) -> list[str]:
    messages: list[str] = []
    for item in chat:
        if item.get("role") == "user" and isinstance(item.get("content"), str):
            value = item["content"].strip()
            if value:
                messages.append(value[:1200])
    if current_message and (not messages or messages[-1] != current_message):
        messages.append(current_message[:1200])
    return messages[-5:]


def record_blocked_attempt(ip_address: str, message: str, chat: list[dict], account: dict | None = None) -> None:
    context = {
        "messages": last_user_messages(chat, message),
        "account": {
            "id": account.get("id") if account else None,
            "username": account.get("username") if account else "",
        },
    }
    placeholder = db_placeholder()
    db_execute(
        f"INSERT INTO blocked_attempts (created_at, ip_address, message, context_json) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder})",
        (utc_iso(), ip_address[:80], message[:2000], json.dumps(context)),
    )


def safe_record_blocked_attempt(ip_address: str, message: str, chat: list[dict], account: dict | None = None) -> None:
    try:
        record_blocked_attempt(ip_address, message, chat, account)
    except Exception:
        pass


def blocked_attempts(include_all: bool = False) -> list[dict]:
    sql = "SELECT id, created_at, ip_address, message, context_json FROM blocked_attempts ORDER BY created_at DESC"
    if not include_all:
        sql += " LIMIT 20"
    rows = db_query(sql)
    attempts = []
    for row in rows:
        try:
            raw_context = json.loads(row.get("context_json") or "[]")
        except Exception:
            raw_context = []
        if isinstance(raw_context, dict):
            context = raw_context.get("messages") if isinstance(raw_context.get("messages"), list) else []
            account = raw_context.get("account") if isinstance(raw_context.get("account"), dict) else {}
        else:
            context = raw_context if isinstance(raw_context, list) else []
            account = {}
        account_row = find_account_by_id(account.get("id")) if account.get("id") else verified_account_for_username(account.get("username"))
        attempts.append(
            {
                "id": row.get("id"),
                "createdAt": row.get("created_at"),
                "ipAddress": row.get("ip_address"),
                "message": row.get("message") or "",
                "context": context[-5:],
                "accountId": account.get("id"),
                "username": account.get("username") or "",
                "isVerified": account_is_verified(account_row),
            }
        )
    return attempts


def blocked_attempt_by_id(attempt_id: object) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(f"SELECT id, created_at, ip_address, message, context_json FROM blocked_attempts WHERE id = {placeholder}", (attempt_id,))
    if not rows:
        return None
    row = rows[0]
    attempts = blocked_attempts(True)
    for attempt in attempts:
        if str(attempt.get("id")) == str(row.get("id")):
            return attempt
    return None


def delete_blocked_attempt(attempt_id: object) -> None:
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM blocked_attempts WHERE id = {placeholder}", (attempt_id,))


def normalize_reporter_client_id(value: object) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]", "", str(value or "").strip())
    return cleaned[:120]


def request_reporter_client_id(payload: dict | None = None) -> str:
    header_value = request.headers.get("X-Aether-Reporter-Id", "")
    if header_value:
        return normalize_reporter_client_id(header_value)
    if isinstance(payload, dict):
        return normalize_reporter_client_id(payload.get("reporterClientId"))
    return ""


def normalize_report_context(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    context = []
    for item in value[:8]:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        role = "user" if item.get("role") == "user" else "assistant"
        context.append(
            {
                "id": str(item.get("id") or "")[:120],
                "role": role,
                "content": content[:1200],
                "createdAt": str(item.get("createdAt") or item.get("created_at") or "")[:40],
            }
        )
    return context


def create_message_report(payload: dict, ip_address: str, account: dict | None = None) -> None:
    content = str(payload.get("messageContent") or "").strip()
    if not content:
        raise ValueError("Message content is required.")
    message_id = str(payload.get("messageId") or "").strip()[:120]
    if not message_id:
        raise ValueError("Message ID is required.")
    message_role = "assistant" if payload.get("messageRole") == "assistant" else "user"
    reporter_client_id = request_reporter_client_id(payload)
    reporter_account_id = account.get("id") if account else None
    if not reporter_account_id and not reporter_client_id:
        raise ValueError("Reporter ID is required.")
    now = utc_iso()
    placeholder = db_placeholder()
    db_execute(
        (
            "INSERT INTO message_reports "
            "(created_at, reporter_account_id, reporter_client_id, reporter_username, reporter_ip, chat_id, chat_title, "
            "message_id, message_role, message_content, report_note, context_json, status) "
            f"VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, "
            f"{placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder})"
        ),
        (
            now,
            reporter_account_id,
            reporter_client_id,
            account.get("username") if account else "",
            str(ip_address or "")[:80],
            str(payload.get("chatId") or "")[:120],
            str(payload.get("chatTitle") or "")[:120],
            message_id,
            message_role,
            content[:4000],
            str(payload.get("note") or "").strip()[:1000],
            json.dumps(normalize_report_context(payload.get("context")), separators=(",", ":")),
            "open",
        ),
    )


def message_reports(include_resolved: bool = False) -> list[dict]:
    sql = (
        "SELECT id, created_at, reporter_account_id, reporter_client_id, reporter_username, reporter_ip, "
        "chat_id, chat_title, message_id, message_role, message_content, report_note, context_json, "
        "status, resolved_at, resolved_by_account_id FROM message_reports"
    )
    if not include_resolved:
        sql += " WHERE status = 'open'"
    sql += " ORDER BY created_at DESC LIMIT 80"
    rows = db_query(sql)
    reports = []
    for row in rows:
        try:
            context = json.loads(row.get("context_json") or "[]")
        except Exception:
            context = []
        account = find_account_by_id(row.get("reporter_account_id")) if row.get("reporter_account_id") is not None else None
        resolved_by = find_account_by_id(row.get("resolved_by_account_id")) if row.get("resolved_by_account_id") is not None else None
        reports.append(
            {
                "id": row.get("id"),
                "createdAt": row.get("created_at"),
                "reporterAccountId": row.get("reporter_account_id"),
                "reporterUsername": (account or {}).get("username") or row.get("reporter_username") or "",
                "reporterIsVerified": account_is_verified(account),
                "reporterIp": row.get("reporter_ip") or "",
                "chatId": row.get("chat_id") or "",
                "chatTitle": row.get("chat_title") or "",
                "messageId": row.get("message_id") or "",
                "messageRole": row.get("message_role") or "assistant",
                "messageContent": row.get("message_content") or "",
                "note": row.get("report_note") or "",
                "context": context if isinstance(context, list) else [],
                "status": row.get("status") or "open",
                "resolvedAt": row.get("resolved_at"),
                "resolvedByUsername": (resolved_by or {}).get("username") or "",
            }
        )
    return reports


def message_report_by_id(report_id: object) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(
        (
            "SELECT id, reporter_account_id, reporter_client_id, status, notification_seen_at "
            f"FROM message_reports WHERE id = {placeholder}"
        ),
        (report_id,),
    )
    return rows[0] if rows else None


def resolve_message_report(report_id: object, status: str, admin_account_id: object) -> None:
    if status not in {"fixed", "ignored"}:
        raise ValueError("Report status is invalid.")
    report = message_report_by_id(report_id)
    if not report:
        raise ValueError("Report was not found.")
    now = utc_iso()
    placeholder = db_placeholder()
    notification_seen_at = None if status == "fixed" else now
    db_execute(
        (
            f"UPDATE message_reports SET status = {placeholder}, resolved_at = {placeholder}, "
            f"resolved_by_account_id = {placeholder}, notification_seen_at = {placeholder} "
            f"WHERE id = {placeholder}"
        ),
        (status, now, admin_account_id, notification_seen_at, report_id),
    )


def report_notifications(account: dict | None = None, reporter_client_id: str = "") -> list[dict]:
    reporter_client_id = normalize_reporter_client_id(reporter_client_id)
    identity_clauses = []
    params: list[object] = []
    placeholder = db_placeholder()
    if account and account.get("id") is not None:
        identity_clauses.append(f"reporter_account_id = {placeholder}")
        params.append(account.get("id"))
    if reporter_client_id:
        identity_clauses.append(f"reporter_client_id = {placeholder}")
        params.append(reporter_client_id)
    if not identity_clauses:
        return []
    sql = (
        "SELECT id, created_at, resolved_at, message_content "
        "FROM message_reports WHERE status = 'fixed' AND notification_seen_at IS NULL "
        f"AND ({' OR '.join(identity_clauses)}) ORDER BY resolved_at DESC LIMIT 5"
    )
    rows = db_query(sql, tuple(params))
    return [
        {
            "id": row.get("id"),
            "reportedAt": row.get("created_at"),
            "fixedAt": row.get("resolved_at"),
            "messageContent": row.get("message_content") or "",
        }
        for row in rows
    ]


def mark_report_notification_seen(report_id: object, account: dict | None = None, reporter_client_id: str = "") -> bool:
    report = message_report_by_id(report_id)
    if not report or str(report.get("status") or "") != "fixed":
        return False
    reporter_client_id = normalize_reporter_client_id(reporter_client_id)
    matches_account = bool(account and str(report.get("reporter_account_id") or "") == str(account.get("id") or ""))
    matches_client = bool(reporter_client_id and reporter_client_id == str(report.get("reporter_client_id") or ""))
    if not matches_account and not matches_client:
        return False
    placeholder = db_placeholder()
    db_execute(
        f"UPDATE message_reports SET notification_seen_at = {placeholder} WHERE id = {placeholder}",
        (utc_iso(), report_id),
    )
    return True


def normalize_username(username: object) -> str:
    return re.sub(r"\s+", "", str(username or "").strip())[:32]


def validate_username(username: str) -> str:
    username = normalize_username(username)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,24}", username):
        raise ValueError("Username must be 3-24 characters and use letters, numbers, dots, dashes, or underscores.")
    return username


def validate_password(password: object) -> str:
    password = str(password or "")
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters.")
    if len(password) > 128:
        raise ValueError("Password must be 128 characters or fewer.")
    return password


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: object, stored_hash: object) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = str(stored_hash or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = hashlib.pbkdf2_hmac(
            "sha256",
            str(password or "").encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        ).hex()
        return hmac.compare_digest(expected, digest_hex)
    except Exception:
        return False


def account_is_verified(row: dict | None) -> bool:
    if not row:
        return False
    try:
        return int(row.get("verified") or 0) == 1
    except Exception:
        return str(row.get("verified") or "").strip().lower() in {"1", "true", "yes"}


def account_public(row: dict | None) -> dict | None:
    if not row:
        return None
    profile_picture = account_profile_picture(row.get("id"))
    is_owner = is_owner_account(row)
    return {
        "id": row.get("id"),
        "username": row.get("username") or "",
        "createdAt": row.get("created_at"),
        "lastLoginAt": row.get("last_login_at"),
        "profilePictureUrl": profile_picture.get("approvedDataUrl") or "",
        "profilePicturePending": bool(profile_picture.get("pendingDataUrl")),
        "isAdmin": is_owner or has_admin_access(row.get("id")),
        "isOwnerAdmin": is_owner,
        "isVerified": account_is_verified(row),
    }


def is_owner_account(row: dict | None) -> bool:
    if not row:
        return False
    username_lc = str(row.get("username_lc") or row.get("username") or "").strip().lower()
    return username_lc == OWNER_ADMIN_USERNAME


def has_admin_access(account_id: object) -> bool:
    if account_id is None or str(account_id).strip() == "":
        return False
    placeholder = db_placeholder()
    rows = db_query(f"SELECT account_id FROM account_admins WHERE account_id = {placeholder}", (account_id,))
    return bool(rows)


def is_admin_account(row: dict | None) -> bool:
    return bool(row and (is_owner_account(row) or has_admin_access(row.get("id"))))


def grant_admin_access(account_id: object, granted_by: object) -> None:
    account = find_account_by_id(account_id)
    if not account:
        raise ValueError("Account was not found.")
    if is_owner_account(account) or has_admin_access(account_id):
        return
    now = utc_iso()
    placeholder = db_placeholder()
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO account_admins (account_id, granted_by, created_at) VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by), created_at = VALUES(created_at)"
            ),
            (account_id, granted_by, now),
        )
    else:
        db_execute(
            (
                f"INSERT INTO account_admins (account_id, granted_by, created_at) VALUES ({placeholder}, {placeholder}, {placeholder}) "
                "ON CONFLICT(account_id) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at"
            ),
            (account_id, granted_by, now),
        )


def revoke_admin_access(account_id: object) -> None:
    account = find_account_by_id(account_id)
    if not account:
        raise ValueError("Account was not found.")
    if is_owner_account(account):
        raise ValueError("The owner admin cannot be removed.")
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM account_admins WHERE account_id = {placeholder}", (account_id,))


def admin_summaries() -> list[dict]:
    owner = find_account_by_username(OWNER_ADMIN_USERNAME)
    rows = db_query(
        (
            "SELECT accounts.id, accounts.username, accounts.username_lc, accounts.created_at, accounts.updated_at, accounts.last_login_at, accounts.verified, "
            "account_admins.created_at AS admin_created_at "
            "FROM account_admins JOIN accounts ON accounts.id = account_admins.account_id ORDER BY account_admins.created_at DESC"
        )
    )
    admins = []
    seen = set()
    if owner:
        admins.append(
            {
                "id": owner.get("id"),
                "username": owner.get("username") or "",
                "createdAt": owner.get("created_at"),
                "updatedAt": owner.get("updated_at"),
                "lastLoginAt": owner.get("last_login_at"),
                "adminSince": owner.get("created_at"),
                "isOwnerAdmin": True,
                "isAdmin": True,
                "isVerified": account_is_verified(owner),
            }
        )
        seen.add(str(owner.get("id")))
    for row in rows:
        if str(row.get("id")) in seen:
            continue
        admins.append(
            {
                "id": row.get("id"),
                "username": row.get("username") or "",
                "createdAt": row.get("created_at"),
                "updatedAt": row.get("updated_at"),
                "lastLoginAt": row.get("last_login_at"),
                "adminSince": row.get("admin_created_at"),
                "isOwnerAdmin": is_owner_account(row),
                "isAdmin": True,
                "isVerified": account_is_verified(row),
            }
        )
    return admins


def account_profile_picture(account_id: object) -> dict:
    if account_id is None or str(account_id).strip() == "":
        return {"approvedDataUrl": "", "pendingDataUrl": "", "pendingAt": None, "approvedAt": None}
    placeholder = db_placeholder()
    rows = db_query(
        (
            "SELECT approved_data_url, approved_at, pending_data_url, pending_at "
            f"FROM account_profile_pictures WHERE account_id = {placeholder}"
        ),
        (account_id,),
    )
    if not rows:
        return {"approvedDataUrl": "", "pendingDataUrl": "", "pendingAt": None, "approvedAt": None}
    row = rows[0]
    return {
        "approvedDataUrl": row.get("approved_data_url") or "",
        "approvedAt": row.get("approved_at"),
        "pendingDataUrl": row.get("pending_data_url") or "",
        "pendingAt": row.get("pending_at"),
    }


def validate_profile_picture_data_url(value: object) -> str:
    data_url = str(value or "").strip()
    if not data_url:
        raise ValueError("Choose a profile picture first.")
    if len(data_url) > MAX_PROFILE_PICTURE_DATA_URL_LENGTH:
        raise ValueError("Profile picture is too large.")
    if not re.fullmatch(r"data:image/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+", data_url):
        raise ValueError("Profile picture must be a PNG, JPG, or WebP image.")
    return re.sub(r"\s+", "", data_url)


def set_pending_profile_picture(account_id: object, data_url: object) -> None:
    data_url = validate_profile_picture_data_url(data_url)
    now = utc_iso()
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO account_profile_pictures (account_id, pending_data_url, pending_at) VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE pending_data_url = VALUES(pending_data_url), pending_at = VALUES(pending_at)"
            ),
            (account_id, data_url, now),
        )
    else:
        db_execute(
            (
                "INSERT INTO account_profile_pictures (account_id, approved_data_url, approved_at, pending_data_url, pending_at) "
                "VALUES (?, NULL, NULL, ?, ?) "
                "ON CONFLICT(account_id) DO UPDATE SET pending_data_url = excluded.pending_data_url, pending_at = excluded.pending_at"
            ),
            (account_id, data_url, now),
        )


def delete_profile_picture(account_id: object) -> None:
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM account_profile_pictures WHERE account_id = {placeholder}", (account_id,))


def pending_profile_pictures() -> list[dict]:
    rows = db_query(
        (
            "SELECT accounts.id, accounts.username, accounts.verified, account_profile_pictures.pending_data_url, account_profile_pictures.pending_at "
            "FROM account_profile_pictures JOIN accounts ON accounts.id = account_profile_pictures.account_id "
            "WHERE account_profile_pictures.pending_data_url IS NOT NULL AND account_profile_pictures.pending_data_url <> '' "
            "ORDER BY account_profile_pictures.pending_at ASC"
        )
    )
    return [
        {
            "accountId": row.get("id"),
            "username": row.get("username") or "",
            "isVerified": account_is_verified(row),
            "imageDataUrl": row.get("pending_data_url") or "",
            "submittedAt": row.get("pending_at"),
        }
        for row in rows
    ]


def approve_profile_picture(account_id: object) -> None:
    picture = account_profile_picture(account_id)
    if not picture.get("pendingDataUrl"):
        raise ValueError("No pending profile picture was found.")
    placeholder = db_placeholder()
    now = utc_iso()
    db_execute(
        (
            f"UPDATE account_profile_pictures SET approved_data_url = {placeholder}, approved_at = {placeholder}, "
            f"pending_data_url = NULL, pending_at = NULL WHERE account_id = {placeholder}"
        ),
        (picture["pendingDataUrl"], now, account_id),
    )


def decline_profile_picture(account_id: object) -> None:
    placeholder = db_placeholder()
    db_execute(
        f"UPDATE account_profile_pictures SET pending_data_url = NULL, pending_at = NULL WHERE account_id = {placeholder}",
        (account_id,),
    )


def normalize_chat_message(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    content = str(value.get("content") or "")
    if not content:
        return None
    role = "user" if value.get("role") == "user" else "assistant"
    created_at = str(value.get("createdAt") or value.get("created_at") or utc_iso())[:40]
    message_id = str(value.get("id") or secrets.token_urlsafe(12))[:120]
    voice = bool(value.get("voice"))
    message = {
        "id": message_id,
        "role": role,
        "content": content[:MAX_CHAT_MESSAGE_CONTENT_LENGTH],
        "createdAt": created_at,
    }
    if voice:
        message["voice"] = True
    reported_at = str(value.get("reportedAt") or value.get("reported_at") or "")[:40]
    if reported_at:
        message["reportedAt"] = reported_at
    return message


def normalize_account_chat(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    messages = [message for message in (normalize_chat_message(item) for item in value.get("messages", [])) if message]
    if not messages:
        return None
    now = utc_iso()
    title = str(value.get("title") or "New conversation").strip()[:80] or "New conversation"
    chat_id = str(value.get("id") or secrets.token_urlsafe(12))[:120]
    return {
        "id": chat_id,
        "title": title,
        "createdAt": str(value.get("createdAt") or value.get("created_at") or now)[:40],
        "updatedAt": str(value.get("updatedAt") or value.get("updated_at") or now)[:40],
        "safetyLocked": bool(value.get("safetyLocked") or value.get("safety_locked")),
        "safetyReason": str(value.get("safetyReason") or value.get("safety_reason") or "")[:80],
        "safetyLockedAt": str(value.get("safetyLockedAt") or value.get("safety_locked_at") or "")[:40],
        "messages": messages[:MAX_CHAT_MESSAGES_PER_CHAT],
    }


def normalize_account_chats(chats: object) -> list[dict]:
    if not isinstance(chats, list):
        return []
    normalized = [chat for chat in (normalize_account_chat(item) for item in chats[:MAX_ACCOUNT_CHATS]) if chat]
    normalized.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    return normalized


def account_chat_state(account_id: object) -> dict:
    placeholder = db_placeholder()
    rows = db_query(
        f"SELECT chats_json, active_chat_id, updated_at FROM account_chats WHERE account_id = {placeholder}",
        (account_id,),
    )
    if not rows:
        return {"hasChats": False, "chats": [], "activeChatId": "", "updatedAt": None}
    row = rows[0]
    raw_chats = []
    try:
        raw_chats = json.loads(row.get("chats_json") or "[]")
        chats = normalize_account_chats(raw_chats)
    except Exception:
        chats = []
    if chats != raw_chats:
        now = utc_iso()
        active_chat_id = row.get("active_chat_id") or ""
        if active_chat_id and not any(str(chat.get("id")) == str(active_chat_id) for chat in chats):
            active_chat_id = str(chats[0].get("id") or "") if chats else ""
        db_execute(
            f"UPDATE account_chats SET chats_json = {placeholder}, active_chat_id = {placeholder}, updated_at = {placeholder} WHERE account_id = {placeholder}",
            (json.dumps(chats, separators=(",", ":")), active_chat_id, now, account_id),
        )
        row["active_chat_id"] = active_chat_id
        row["updated_at"] = now
    return {
        "hasChats": True,
        "chats": chats,
        "activeChatId": row.get("active_chat_id") or "",
        "updatedAt": row.get("updated_at"),
    }


def save_account_chat_state(account_id: object, chats: object, active_chat_id: object) -> dict:
    normalized = normalize_account_chats(chats)
    active_chat_id = str(active_chat_id or "")[:120]
    if active_chat_id and not any(str(chat.get("id")) == active_chat_id for chat in normalized):
        active_chat_id = ""
    if not active_chat_id and normalized:
        active_chat_id = str(normalized[0].get("id") or "")
    now = utc_iso()
    chats_json = json.dumps(normalized, separators=(",", ":"))
    placeholder = db_placeholder()
    if database_provider() == "mysql":
        db_execute(
            (
                "INSERT INTO account_chats (account_id, chats_json, active_chat_id, updated_at) VALUES (%s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE chats_json = VALUES(chats_json), active_chat_id = VALUES(active_chat_id), updated_at = VALUES(updated_at)"
            ),
            (account_id, chats_json, active_chat_id, now),
        )
    else:
        db_execute(
            (
                f"INSERT INTO account_chats (account_id, chats_json, active_chat_id, updated_at) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder}) "
                "ON CONFLICT(account_id) DO UPDATE SET chats_json = excluded.chats_json, active_chat_id = excluded.active_chat_id, updated_at = excluded.updated_at"
            ),
            (account_id, chats_json, active_chat_id, now),
        )
    return account_chat_state(account_id)


def find_account_by_username(username: str) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(f"SELECT id, username, username_lc, password_hash, created_at, updated_at, last_login_at, verified FROM accounts WHERE username_lc = {placeholder}", (username.lower(),))
    return rows[0] if rows else None


def find_account_by_id(account_id: object) -> dict | None:
    placeholder = db_placeholder()
    rows = db_query(f"SELECT id, username, username_lc, password_hash, created_at, updated_at, last_login_at, verified FROM accounts WHERE id = {placeholder}", (account_id,))
    return rows[0] if rows else None


def create_account(username: object, password: object) -> dict:
    username = validate_username(username)
    password = validate_password(password)
    if find_account_by_username(username):
        raise ValueError("That username is already taken.")

    placeholder = db_placeholder()
    now = utc_iso()
    db_execute(
        f"INSERT INTO accounts (username, username_lc, password_hash, created_at, updated_at) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder})",
        (username, username.lower(), hash_password(password), now, now),
    )
    account = find_account_by_username(username)
    if not account:
        raise ValueError("Account could not be created.")
    return account


def update_account_username(account_id: object, username: object) -> dict:
    username = validate_username(username)
    existing = find_account_by_username(username)
    if existing and str(existing.get("id")) != str(account_id):
        raise ValueError("That username is already taken.")

    placeholder = db_placeholder()
    db_execute(
        f"UPDATE accounts SET username = {placeholder}, username_lc = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}",
        (username, username.lower(), utc_iso(), account_id),
    )
    account = find_account_by_id(account_id)
    if not account:
        raise ValueError("Account was not found.")
    return account


def update_account_password(account_id: object, current_password: object, new_password: object) -> None:
    account = find_account_by_id(account_id)
    if not account or not verify_password(current_password, account.get("password_hash")):
        raise ValueError("Current password is incorrect.")
    new_password = validate_password(new_password)
    placeholder = db_placeholder()
    db_execute(
        f"UPDATE accounts SET password_hash = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}",
        (hash_password(new_password), utc_iso(), account_id),
    )
    db_execute(f"DELETE FROM account_sessions WHERE account_id = {placeholder}", (account_id,))


def set_account_verified(account_id: object, verified: bool = True) -> dict:
    account = find_account_by_id(account_id)
    if not account:
        raise ValueError("Account was not found.")
    placeholder = db_placeholder()
    db_execute(
        f"UPDATE accounts SET verified = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}",
        (1 if verified else 0, utc_iso(), account_id),
    )
    updated = find_account_by_id(account_id)
    if not updated:
        raise ValueError("Account was not found.")
    return updated


def delete_account(account_id: object) -> None:
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM account_sessions WHERE account_id = {placeholder}", (account_id,))
    db_execute(f"DELETE FROM account_profile_pictures WHERE account_id = {placeholder}", (account_id,))
    db_execute(f"DELETE FROM account_chats WHERE account_id = {placeholder}", (account_id,))
    db_execute(f"DELETE FROM account_admins WHERE account_id = {placeholder}", (account_id,))
    db_execute(f"DELETE FROM banned_accounts WHERE account_id = {placeholder}", (account_id,))
    db_execute(f"DELETE FROM accounts WHERE id = {placeholder}", (account_id,))


def account_summaries() -> list[dict]:
    rows = db_query("SELECT id, username, username_lc, created_at, updated_at, last_login_at, verified FROM accounts ORDER BY created_at DESC")
    return [
        {
            "id": row.get("id"),
            "username": row.get("username") or "",
            "createdAt": row.get("created_at"),
            "updatedAt": row.get("updated_at"),
            "lastLoginAt": row.get("last_login_at"),
            "profilePictureUrl": account_profile_picture(row.get("id")).get("approvedDataUrl") or "",
            "isAdmin": is_admin_account(row),
            "isOwnerAdmin": is_owner_account(row),
            "isBanned": is_account_banned(row.get("id")),
            "isVerified": account_is_verified(row),
            "rateLimit": rate_limit_status(account_id=row.get("id")),
        }
        for row in rows
    ]


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def request_session_token() -> str:
    authorization = request.headers.get("Authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    if cookie_token:
        return cookie_token
    return ""


def create_account_session(account_id: object, ip_address: str, user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    now = utc_now()
    expires_at = now + timedelta(days=SESSION_LIFETIME_DAYS)
    placeholder = db_placeholder()
    db_execute(
        f"INSERT INTO account_sessions (account_id, token_hash, created_at, expires_at, last_seen_at, ip_address, user_agent) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder})",
        (
            account_id,
            session_token_hash(token),
            now.isoformat(),
            expires_at.isoformat(),
            now.isoformat(),
            ip_address[:80],
            user_agent[:255],
        ),
    )
    db_execute(f"UPDATE accounts SET last_login_at = {placeholder}, updated_at = {placeholder} WHERE id = {placeholder}", (now.isoformat(), now.isoformat(), account_id))
    return token


def delete_account_session(token: str) -> None:
    if not token:
        return
    placeholder = db_placeholder()
    db_execute(f"DELETE FROM account_sessions WHERE token_hash = {placeholder}", (session_token_hash(token),))


def current_account() -> dict | None:
    token = request_session_token()
    if not token:
        return None

    placeholder = db_placeholder()
    rows = db_query(
        (
            "SELECT accounts.id, accounts.username, accounts.username_lc, accounts.password_hash, "
            "accounts.created_at, accounts.updated_at, accounts.last_login_at, accounts.verified, account_sessions.expires_at "
            f"FROM account_sessions JOIN accounts ON accounts.id = account_sessions.account_id WHERE account_sessions.token_hash = {placeholder}"
        ),
        (session_token_hash(token),),
    )
    if not rows:
        return None

    row = rows[0]
    if parse_utc(row.get("expires_at")) <= utc_now():
        delete_account_session(token)
        return None
    return row


def account_auth_status() -> dict:
    account = account_public(current_account())
    return {"signedIn": bool(account), "account": account}


def cookie_is_secure() -> bool:
    forwarded_proto = request.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
    host = request.host.split(":", 1)[0].strip().lower()
    if host in {"127.0.0.1", "localhost", "::1"}:
        return False
    return request.is_secure or forwarded_proto == "https" or bool(host)


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_LIFETIME_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=cookie_is_secure(),
        samesite="Lax",
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        "",
        max_age=0,
        httponly=True,
        secure=cookie_is_secure(),
        samesite="Lax",
        path="/",
    )


def account_response(account: dict | None = None, extra: dict | None = None):
    payload = account_auth_status() if account is None else {"signedIn": True, "account": account_public(account)}
    payload["hcaptcha"] = hcaptcha_public_config()
    payload["hcaptchaSiteKey"] = hcaptcha_site_key()
    if extra:
        payload.update(extra)
    return jsonify(payload)


def require_admin():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in with an admin account first."}), 401
    if not is_admin_account(account):
        return jsonify({"error": "Admin access denied."}), 403
    return None


def require_owner_admin():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in with the owner admin account first."}), 401
    if not is_owner_account(account):
        return jsonify({"error": "Only the owner admin can manage admins."}), 403
    return None


def admin_status(include_all_blocked: bool = False) -> dict:
    ensure_admin_db()
    account = current_account()
    return {
        "admin": True,
        "currentAdmin": account_public(account),
        "canManageAdmins": is_owner_account(account),
        "aetherAvailable": is_aether_available(),
        "rateLimit": rate_limit_status(client_ip(), account.get("id") if account else None),
        "requestCounts": request_counts(),
        "bannedIps": banned_ips(),
        "bannedAccounts": banned_accounts(),
        "blockedAttempts": blocked_attempts(include_all_blocked),
        "messageReports": message_reports(),
        "accounts": account_summaries(),
        "admins": admin_summaries(),
        "pendingProfilePictures": pending_profile_pictures(),
        "database": database_summary(),
    }


def groq_api_keys() -> list[str]:
    candidates = []
    primary_key = os.getenv("GROQ_API_KEY", "").strip()
    if primary_key:
        candidates.append(primary_key)

    bulk_keys = os.getenv("GROQ_API_KEYS", "").strip()
    if bulk_keys:
        candidates.extend(re.split(r"[\s,;]+", bulk_keys))

    for index in range(1, 21):
        key = os.getenv(f"GROQ_API_KEY_{index}", "").strip()
        if key:
            candidates.append(key)

    keys = []
    seen = set()
    for key in candidates:
        key = key.strip()
        if not key or "your_" in key or key in seen:
            continue
        keys.append(key)
        seen.add(key)
    return keys


def groq_models() -> list[str]:
    candidates = []
    configured_models = os.getenv("AETHER_GROQ_MODELS", "").strip()
    if configured_models:
        candidates.extend(re.split(r"[\s,;]+", configured_models))

    configured_model = os.getenv("AETHER_GROQ_MODEL", "").strip()
    if configured_model:
        candidates.append(configured_model)

    candidates.extend(["openai/gpt-oss-120b", "llama-3.1-8b-instant", "qwen/qwen3-32b"])

    models = []
    seen = set()
    for model in candidates:
        model = model.strip()
        if model and model not in seen:
            models.append(model)
            seen.add(model)
    return models


def groq_safety_models() -> list[str]:
    candidates = []
    configured_models = os.getenv("AETHER_SAFETY_MODELS", "").strip()
    if configured_models:
        candidates.extend(re.split(r"[\s,;]+", configured_models))

    configured_model = os.getenv("AETHER_SAFETY_MODEL", "").strip()
    if configured_model:
        candidates.append(configured_model)

    candidates.extend(["llama-3.1-8b-instant", "openai/gpt-oss-120b", "qwen/qwen3-32b"])
    models = []
    seen = set()
    for model in candidates:
        model = model.strip()
        if model and model not in seen:
            models.append(model)
            seen.add(model)
    return models


def groq_completion_with_fallback(messages: list[dict]) -> str:
    keys = groq_api_keys()
    if not keys:
        return "I need a quick setup fix before I can answer."

    last_rate_limit_error = None
    last_not_found_error = None
    for model in groq_models():
        for api_key in keys:
            try:
                client = Groq(api_key=api_key)
                completion = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0.6,
                    max_completion_tokens=4096,
                    top_p=0.95,
                    stream=True,
                    stop=None,
                )

                chunks = []
                for chunk in completion:
                    content = chunk.choices[0].delta.content or ""
                    if content:
                        chunks.append(content)

                reply = "".join(chunks).strip()
                return reply or "I could not read a response."
            except APIStatusError as exc:
                if exc.status_code == 429:
                    last_rate_limit_error = exc
                    continue
                if exc.status_code == 404:
                    last_not_found_error = exc
                    break
                raise

    if last_rate_limit_error:
        raise last_rate_limit_error
    if last_not_found_error:
        raise last_not_found_error
    return "I could not read a response."


def safety_classifier_messages(message: str, chat: list[dict]) -> list[dict]:
    recent = []
    for item in chat[-8:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            recent.append({"role": role, "content": content[:1200]})

    return [
        {
            "role": "system",
            "content": (
                "You are Aether's safety classifier. Classify whether the latest user message should lock the current conversation. "
                "Return only one JSON object and no other text. "
                "Lock only when the latest user message asks for, intends, threatens, or meaningfully enables severe personal harm, "
                "real-world violence, weaponized construction or use, exploitation, cyber abuse, or illicit manufacturing. "
                "Do not lock benign, educational, fictional, prevention, recovery, news, moderation, or support-seeking discussion unless the latest message includes active intent, instructions, or enablement. "
                "Schema: {\"safe\": boolean, \"action\": \"continue\" | \"lock_conversation\", \"category\": \"none\" | \"self_harm\" | \"violence\" | \"weapons\" | \"child_safety\" | \"cyber_abuse\" | \"hard_drugs\" | \"other\", \"confidence\": number, \"reason\": string}."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "recentConversation": recent,
                    "latestUserMessage": message[:MAX_CHAT_MESSAGE_CONTENT_LENGTH],
                },
                ensure_ascii=True,
            ),
        },
    ]


def extract_json_object(text: str) -> dict | None:
    text = str(text or "").strip()
    if not text:
        return None
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def normalize_safety_category(value: object) -> str:
    category = re.sub(r"[^a-z0-9_-]+", "_", str(value or "other").strip().lower()).strip("_")
    aliases = {
        "self-harm": "self_harm",
        "harm": "violence",
        "child-sexual": "child_safety",
        "child-safety": "child_safety",
        "cyber-abuse": "cyber_abuse",
        "hard-drugs": "hard_drugs",
    }
    category = aliases.get(category, category)
    return category if category in {"none", "self_harm", "violence", "weapons", "child_safety", "cyber_abuse", "hard_drugs", "other"} else "other"


def normalize_safety_classification(value: dict | None) -> dict | None:
    if not isinstance(value, dict):
        return None
    category = normalize_safety_category(value.get("category"))
    try:
        confidence = float(value.get("confidence", 0))
    except Exception:
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    action = str(value.get("action") or "").strip().lower()
    safe = value.get("safe")
    lock = (
        action == "lock_conversation"
        or value.get("lock") is True
        or value.get("shouldLock") is True
        or (safe is False and category != "none")
    )
    if confidence < SAFETY_CLASSIFIER_CONFIDENCE_THRESHOLD:
        lock = False
    return {
        "lock": bool(lock),
        "reason": category if lock else "",
        "confidence": confidence,
        "source": "model",
    }


def ai_safety_classification(message: str, chat: list[dict]) -> dict | None:
    keys = groq_api_keys()
    if not keys:
        return None

    messages = safety_classifier_messages(message, chat)
    timeout_seconds = bounded_int(os.getenv("AETHER_SAFETY_TIMEOUT_SECONDS", "6"), 6, 2, 20)
    for model in groq_safety_models():
        for api_key in keys:
            try:
                try:
                    client = Groq(api_key=api_key, timeout=timeout_seconds)
                except TypeError:
                    client = Groq(api_key=api_key)
                completion = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0,
                    max_completion_tokens=220,
                    top_p=1,
                    stream=False,
                )
                content = completion.choices[0].message.content or ""
                parsed = normalize_safety_classification(extract_json_object(content))
                if parsed is not None:
                    return parsed
            except APIStatusError as exc:
                if exc.status_code in {404, 429}:
                    continue
                continue
            except Exception:
                continue
    return None


def classify_message_safety(message: str, chat: list[dict]) -> dict:
    model_result = ai_safety_classification(message, chat)
    if model_result is not None:
        return model_result
    fallback_reason = safety_lock_reason(message)
    if fallback_reason:
        return {
            "lock": True,
            "reason": normalize_safety_category(fallback_reason),
            "confidence": 1.0,
            "source": "fallback",
        }
    return {"lock": False, "reason": "", "confidence": 0.0, "source": "fallback"}


def normalized_speed_mode(value: object) -> str:
    return "fast" if str(value or "").strip().lower() == "fast" else "default"


def speed_mode_rate_limit_cost(speed_mode: str) -> int:
    return FAST_MODE_RATE_LIMIT_COST if normalized_speed_mode(speed_mode) == "fast" else 1


def aether_system_prompt(speed_mode: str) -> str:
    if normalized_speed_mode(speed_mode) == "fast":
        return (
            "You are Aether."
            "Never mention providers, sources, tokens, "
            "or implementation details. "
            "Always give a short answer."
            "Do not use headings, boldings, italics, blackquotes, ordered lists, unordered lists, codes, horizontal rules, links, images, tables, emojis, or highlights."
            "Never use tables."
        )
    return (
        "You are Aether, a friendly AI model on a website called Aether AI. "
        "Be friendly and nice. Respond as helpful as possible and be respectful. "
        "Never mention providers, sources, tokens, API calls, "
        "or implementation details. "
        "Do not use excessive markdown-text like bolding, italics, pipes, or dashes."
        "Keep responses as helpful and reasonable as possible and give as much guidance as possible."
        "Do not use headings, boldings, italics, blackquotes, ordered lists, unordered lists, codes, horizontal rules, links, images, tables, emojis, or highlights."
        "Never use tables."
    )


def groq_reply(message: str, chat: list[dict], speed_mode: str = "default") -> str:
    now = datetime.now().astimezone().strftime("%A, %B %d, %Y at %I:%M %p %Z")
    messages = [
        {
            "role": "system",
            "content": aether_system_prompt(speed_mode),
        }
    ]
    for item in chat[-20:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})

    if not any(item["role"] == "user" and item["content"] == message for item in messages):
        messages.append({"role": "user", "content": message})

    return groq_completion_with_fallback(messages)


def looks_like_weather_request(message: str) -> bool:
    return bool(re.search(r"\b(weather|forecast|temperature)\b", message, re.I))


def looks_like_location_time_request(message: str) -> bool:
    return bool(re.search(r"\b(?:what\s+time\s+is\s+it|what['’]?s\s+the\s+time)\b", message, re.I))


def weather_reply(latitude: float, longitude: float) -> str:
    params = urllib.parse.urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "timezone": "auto",
        }
    )
    url = f"https://api.open-meteo.com/v1/forecast?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "AetherAI/1.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
        data = json.loads(response.read().decode("utf-8"))

    current = data.get("current", {})
    daily = data.get("daily", {})
    temp = current.get("temperature_2m")
    feels = current.get("apparent_temperature")
    humidity = current.get("relative_humidity_2m")
    wind = current.get("wind_speed_10m")
    code = current.get("weather_code")
    condition = WEATHER_CODES.get(code, f"weather code {code}")
    high = (daily.get("temperature_2m_max") or [None])[0]
    low = (daily.get("temperature_2m_min") or [None])[0]
    rain_chance = (daily.get("precipitation_probability_max") or [None])[0]

    return (
        f"Right now near you: {condition}, {temp}F, feels like {feels}F. "
        f"Humidity is {humidity}% and wind is {wind} mph. "
        f"Today should be about {high}F high and {low}F low"
        + (f", with a {rain_chance}% max precipitation chance." if rain_chance is not None else ".")
    )


def location_time_reply(latitude: float, longitude: float) -> str:
    params = urllib.parse.urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": "temperature_2m",
            "timezone": "auto",
        }
    )
    url = f"https://api.open-meteo.com/v1/forecast?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "AetherAI/1.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
        data = json.loads(response.read().decode("utf-8"))

    timezone_name = data.get("timezone") or "UTC"
    offset_seconds = int(data.get("utc_offset_seconds") or 0)
    now = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)

    abbreviation = data.get("timezone_abbreviation") or timezone_name
    time_text = now.strftime("%I:%M %p").lstrip("0")
    date_text = now.strftime("%A, %B %d, %Y")
    return f"It is {time_text} {abbreviation} in your timezone ({timezone_name}) on {date_text}."


def coordinates_from_location(location: object) -> tuple[float, float]:
    if isinstance(location, str):
        location = json.loads(location)
    if not isinstance(location, dict):
        raise ValueError("Location was not provided in a usable format.")

    latitude = location.get("latitude")
    longitude = location.get("longitude")
    if latitude is None or longitude is None:
        coords = location.get("coords") if isinstance(location.get("coords"), dict) else {}
        latitude = coords.get("latitude")
        longitude = coords.get("longitude")
    if latitude is None or longitude is None:
        raise ValueError("Location is missing latitude or longitude.")
    return float(latitude), float(longitude)


def client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        value = forwarded_for.split(",", 1)[0].strip()
    else:
        value = request.remote_addr or "127.0.0.1"
    return value[:80] or "127.0.0.1"


def hcaptcha_site_key() -> str:
    return (os.getenv("HCAPTCHA_SITE_KEY") or os.getenv("AETHER_HCAPTCHA_SITE_KEY") or "").strip()


def hcaptcha_secret_key() -> str:
    return (os.getenv("HCAPTCHA_SECRET") or os.getenv("HCAPTCHA_SECRET_KEY") or os.getenv("AETHER_HCAPTCHA_SECRET") or "").strip()


def hcaptcha_public_config() -> dict:
    site_key = hcaptcha_site_key()
    return {
        "enabled": bool(site_key),
        "siteKey": site_key,
    }


def captcha_token_from_payload(payload: dict) -> str:
    for key in ("captchaToken", "hcaptchaToken", "h-captcha-response"):
        token = str(payload.get(key) or "").strip()
        if token:
            return token
    return ""


def verify_hcaptcha_token(token: str, ip_address: str) -> tuple[bool, str]:
    site_key = hcaptcha_site_key()
    secret_key = hcaptcha_secret_key()
    token = str(token or "").strip()
    if not site_key or not secret_key:
        return False, "Captcha is not configured."
    if not token:
        return False, "Complete the captcha before continuing."

    form = {
        "secret": secret_key,
        "response": token,
        "remoteip": ip_address,
        "sitekey": site_key,
    }
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        HCAPTCHA_VERIFY_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            body = response.read().decode("utf-8", "replace")
        result = json.loads(body)
    except Exception:
        return False, "Captcha verification is unavailable. Try again."

    if result.get("success") is True:
        return True, ""
    return False, "Captcha verification failed. Try again."


def require_hcaptcha(payload: dict, ip_address: str) -> tuple[bool, str]:
    return verify_hcaptcha_token(captcha_token_from_payload(payload), ip_address)


def chat_response(payload: dict, ip_address: str, account: dict | None = None) -> dict:
    account_id = account.get("id") if account else None
    message = str(payload.get("message", "")).strip()[:MAX_CHAT_MESSAGE_CONTENT_LENGTH]
    masked_message = mask_profanity(message)
    chat = payload.get("chat") if isinstance(payload.get("chat"), list) else []
    chat = mask_chat_profanity(chat[:MAX_CHAT_MESSAGES_PER_CHAT])
    location = payload.get("location")
    speed_mode = normalized_speed_mode(payload.get("speedMode"))
    rate_limit_cost = speed_mode_rate_limit_cost(speed_mode)
    if not message:
        return {"reply": "Send a message first."}
    if not is_aether_available():
        return {
            "aetherUnavailable": True,
            "aetherAvailable": False,
            "rateLimit": rate_limit_status(ip_address, account_id),
        }
    ban_record = request_ban_record(ip_address, account)
    if ban_record:
        return {
            "reply": "You can not use Aether AI because you were banned by an admin.",
            "banned": True,
            "ban": public_ban_details(ban_record),
        }
    if message_captcha_required(ip_address, account_id) and not consume_message_captcha_pass(ip_address, account_id):
        return {
            "reply": "Complete the captcha to continue.",
            "captchaRequired": True,
            "captchaPurpose": "message-rate",
            "maskedMessage": masked_message,
            "rateLimit": rate_limit_status(ip_address, account_id),
        }
    scan_limit = consume_safety_scan_rate_limit(ip_address, account_id)
    if not scan_limit["allowed"]:
        return {
            "reply": REQUEST_BACKOFF_MESSAGE,
            "rateLimited": True,
            "rateLimit": rate_limit_status(ip_address, account_id),
        }
    safety = classify_message_safety(message, chat)
    if safety.get("lock"):
        safe_record_blocked_attempt(ip_address, masked_message, chat, account)
        return {
            "safetyLocked": True,
            "safetyReason": safety.get("reason") or "safety",
            "rateLimit": rate_limit_status(ip_address, account_id),
            "maskedMessage": masked_message,
        }
    if looks_like_location_time_request(message) and not location:
        return {"reply": "Aether needs your permission to see your location to give your location."}
    rate = consume_rate_limit(ip_address, account_id, rate_limit_cost)
    if not rate["allowed"]:
        return {
            "reply": REQUEST_BACKOFF_MESSAGE,
            "rateLimited": True,
            "rateLimit": rate["rateLimit"],
        }
    if location and looks_like_location_time_request(message):
        latitude, longitude = coordinates_from_location(location)
        reply = location_time_reply(latitude, longitude)
        return {"reply": reply, "rateLimit": rate["rateLimit"], "maskedMessage": masked_message}
    if location and looks_like_weather_request(message):
        latitude, longitude = coordinates_from_location(location)
        reply = weather_reply(latitude, longitude)
        return {"reply": reply, "rateLimit": rate["rateLimit"], "maskedMessage": masked_message}
    reply = groq_reply(masked_message, chat, speed_mode)
    return {"reply": reply, "rateLimit": rate["rateLimit"], "maskedMessage": masked_message}


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "").strip()
    if origin and is_allowed_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    elif not origin:
        response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Aether-Reporter-Id"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=(self)"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "base-uri 'self'; "
        "object-src 'none'; "
        "frame-ancestors 'none'; "
        "script-src 'self' https://js.hcaptcha.com; "
        "frame-src https://*.hcaptcha.com; "
        "connect-src 'self' https://*.hcaptcha.com https://api.hcaptcha.com https://aetherai.wasmer.app http://127.0.0.1:8765; "
        "img-src 'self' data:; "
        "media-src 'self'; "
        "style-src 'self' 'unsafe-inline'"
    )
    return response


@app.before_request
def enforce_request_security():
    if request.method == "OPTIONS":
        return None
    if request.method in {"POST", "PUT", "DELETE"}:
        origin = request.headers.get("Origin", "").strip()
        if origin and not is_allowed_origin(origin):
            return jsonify({"error": "Request origin is not allowed."}), 403
    if request.path.startswith("/api/") and request.path != "/api/status":
        ban_record = request_ban_record(client_ip(), current_account())
        if ban_record:
            return banned_api_response(ban_record)
    return None


def allowed_origins() -> set[str]:
    configured = os.getenv("AETHER_ALLOWED_ORIGINS", "").strip()
    origins = {
        "https://aether.env.pm",
        "https://adamsrealm1.github.io",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    }
    if configured:
        origins.update(value.strip().rstrip("/") for value in re.split(r"[\s,;]+", configured) if value.strip())
    host_url = request.host_url.rstrip("/") if request else ""
    if host_url:
        origins.add(host_url)
    return origins


def is_allowed_origin(origin: str) -> bool:
    origin = str(origin or "").strip().rstrip("/")
    if not origin:
        return False
    if origin in allowed_origins():
        return True
    try:
        parsed = urllib.parse.urlparse(origin)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost"}


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.errorhandler(RequestEntityTooLarge)
def request_entity_too_large(_exc):
    return jsonify({"error": REQUEST_BACKOFF_MESSAGE}), 413


@app.get("/api/status")
def api_status():
    ip_address = client_ip()
    try:
        account = current_account()
        public_account = account_public(account)
    except Exception:
        account = None
        public_account = None
    try:
        ban_record = request_ban_record(ip_address, account)
    except Exception:
        ban_record = None
    try:
        available = is_aether_available()
    except Exception:
        available = True
    try:
        rate_limit = rate_limit_status(ip_address, account.get("id") if account else None)
    except Exception:
        rate_limit = default_rate_limit_status(account.get("id") if account else None)
    try:
        notifications = report_notifications(account, request_reporter_client_id())
    except Exception:
        notifications = []
    return jsonify(
        {
            "aetherAvailable": available,
            "banned": bool(ban_record),
            "ban": public_ban_details(ban_record) if ban_record else {"banned": False},
            "signedIn": bool(public_account),
            "account": public_account,
            "rateLimit": rate_limit,
            "reportNotifications": notifications,
            "hcaptcha": hcaptcha_public_config(),
            "hcaptchaSiteKey": hcaptcha_site_key(),
        }
    )


@app.get("/api/account/session")
def api_account_session():
    return account_response()


@app.post("/api/captcha/verify")
def api_captcha_verify():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    ip_address = client_ip()
    account = current_account()
    verified, error = require_hcaptcha(payload, ip_address)
    if not verified:
        return jsonify({"verified": False, "error": error, "captchaRequired": True}), 400
    if str(payload.get("purpose") or "").strip() == "message-rate":
        grant_message_captcha_pass(ip_address, account.get("id") if account else None)
    return jsonify({"verified": True})


@app.post("/api/account/create")
def api_account_create():
    ip_address = client_ip()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    verified, error = require_hcaptcha(payload, ip_address)
    if not verified:
        return jsonify({"error": error, "captchaRequired": True}), 400
    auth_limit = consume_auth_rate_limit(ip_address)
    if not auth_limit["allowed"]:
        return jsonify({"error": "Too many account attempts. Try again later."}), 429
    try:
        account = create_account(payload.get("username"), payload.get("password"))
        bind_anonymous_rate_limit_to_account(ip_address, account.get("id"))
        token = create_account_session(account.get("id"), ip_address, request.headers.get("User-Agent", ""))
        response = account_response(account, {"message": "Account created.", "sessionToken": token})
        set_session_cookie(response, token)
        return response
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/account/signin")
def api_account_signin():
    ip_address = client_ip()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    verified, error = require_hcaptcha(payload, ip_address)
    if not verified:
        return jsonify({"error": error, "captchaRequired": True}), 400
    auth_limit = consume_auth_rate_limit(ip_address)
    if not auth_limit["allowed"]:
        return jsonify({"error": "Too many sign-in attempts. Try again later."}), 429
    username = normalize_username(payload.get("username"))
    password = str(payload.get("password") or "")
    account = find_account_by_username(username) if username else None
    if not account or not verify_password(password, account.get("password_hash")):
        return jsonify({"error": "Username or password is incorrect."}), 401

    ban_record = banned_account_record(account.get("id"))
    if ban_record:
        return banned_api_response(ban_record)

    bind_anonymous_rate_limit_to_account(ip_address, account.get("id"))
    token = create_account_session(account.get("id"), ip_address, request.headers.get("User-Agent", ""))
    response = account_response(account, {"message": "Signed in.", "sessionToken": token})
    set_session_cookie(response, token)
    return response


@app.post("/api/account/signout")
def api_account_signout():
    account = current_account()
    if account:
        bind_account_rate_limit_to_ip(client_ip(), account.get("id"))
    delete_account_session(request_session_token())
    response = jsonify({"signedIn": False, "account": None, "message": "Signed out."})
    clear_session_cookie(response)
    return response


@app.post("/api/account/username")
def api_account_username():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        account = update_account_username(account.get("id"), payload.get("username"))
        return account_response(account, {"message": "Username updated."})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/account/password")
def api_account_password():
    auth_limit = consume_auth_rate_limit(client_ip())
    if not auth_limit["allowed"]:
        return jsonify({"error": "Too many account attempts. Try again later."}), 429
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        update_account_password(account.get("id"), payload.get("currentPassword"), payload.get("newPassword"))
        token = create_account_session(account.get("id"), client_ip(), request.headers.get("User-Agent", ""))
        account = find_account_by_id(account.get("id"))
        response = account_response(account, {"message": "Password updated.", "sessionToken": token})
        set_session_cookie(response, token)
        return response
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/account/profile-picture")
def api_account_profile_picture():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        set_pending_profile_picture(account.get("id"), payload.get("imageDataUrl"))
        account = find_account_by_id(account.get("id"))
        return account_response(account, {"message": "Profile picture is waiting for admin approval."})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.delete("/api/account/profile-picture")
def api_account_profile_picture_delete():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    delete_profile_picture(account.get("id"))
    account = find_account_by_id(account.get("id"))
    return account_response(account, {"message": "Profile picture removed."})


@app.get("/api/account/chats")
def api_account_chats_get():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    return jsonify(account_chat_state(account.get("id")))


@app.put("/api/account/chats")
def api_account_chats_put():
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    return jsonify(save_account_chat_state(account.get("id"), payload.get("chats"), payload.get("activeChatId")))


@app.post("/api/reports")
def api_reports_create():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        create_message_report(payload, client_ip(), current_account())
        return jsonify({"message": "Report sent to admins."})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/reports/notifications")
def api_report_notifications():
    account = current_account()
    return jsonify({"reportNotifications": report_notifications(account, request_reporter_client_id())})


@app.post("/api/reports/notifications/seen")
def api_report_notification_seen():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    seen = mark_report_notification_seen(payload.get("reportId"), current_account(), request_reporter_client_id(payload))
    if not seen:
        return jsonify({"error": "Report notification was not found."}), 404
    return jsonify({"message": "Report notification acknowledged."})


@app.delete("/api/account")
def api_account_delete():
    auth_limit = consume_auth_rate_limit(client_ip())
    if not auth_limit["allowed"]:
        return jsonify({"error": "Too many account attempts. Try again later."}), 429
    account = current_account()
    if not account:
        return jsonify({"error": "Sign in first."}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    if not verify_password(payload.get("password"), account.get("password_hash")):
        return jsonify({"error": "Password is incorrect."}), 400
    delete_account(account.get("id"))
    response = jsonify({"signedIn": False, "account": None, "message": "Account deleted."})
    clear_session_cookie(response)
    return response


@app.route("/api/admin/status", methods=["GET", "OPTIONS"])
def api_admin_status():
    if request.method == "OPTIONS":
        return ("", 204)
    denied = require_admin()
    if denied:
        return denied
    include_all = request.args.get("all") == "1"
    return jsonify(admin_status(include_all))


@app.post("/api/admin/availability")
def api_admin_availability():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    available = bool(isinstance(payload, dict) and payload.get("available"))
    set_aether_available(available)
    return jsonify(admin_status())


@app.post("/api/admin/reset-rate-limit")
def api_admin_reset_rate_limit():
    denied = require_admin()
    if denied:
        return denied
    reset_all_rate_limits()
    return jsonify(admin_status())


@app.post("/api/admin/rate-limit")
def api_admin_rate_limit():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    set_rate_limit_settings(payload.get("limit"), payload.get("windowSeconds"))
    return jsonify(admin_status())


@app.post("/api/admin/ban-ip")
def api_admin_ban_ip():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        ban_ip(str(payload.get("ipAddress", "")), str(payload.get("reason", "")))
        return jsonify(admin_status())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/ban-user")
def api_admin_ban_user():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        username_input = payload.get("username")
        reason = str(payload.get("reason", "")).strip()
        _account_id, username = ban_account_by_username(username_input, reason or f"User ban: {normalize_username(username_input)}")
        status = admin_status()
        status["message"] = f"Banned {username}."
        return jsonify(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/unban-user")
def api_admin_unban_user():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    unban_account(payload.get("accountId"))
    return jsonify(admin_status())


@app.post("/api/admin/unban-ip")
def api_admin_unban_ip():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    unban_ip(str(payload.get("ipAddress", "")))
    return jsonify(admin_status())


@app.post("/api/admin/blocked-attempt/ban")
def api_admin_blocked_attempt_ban():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    attempt = blocked_attempt_by_id(payload.get("attemptId"))
    if not attempt:
        return jsonify({"error": "Blocked attempt was not found."}), 404
    ip_address = str(attempt.get("ipAddress") or "").strip()
    if not ip_address:
        return jsonify({"error": "Blocked attempt does not have an IP address."}), 400
    username = str(attempt.get("username") or "").strip()
    reason = f"Blocked attempt by {username}" if username else "Blocked attempt"
    if username:
        try:
            _account_id, display_name = ban_account_by_username(username, reason, str(attempt.get("message") or ""))
            ban_label = display_name
        except ValueError:
            ban_ip(ip_address, reason, source_message=str(attempt.get("message") or ""))
            ban_label = ip_address
    else:
        ban_ip(ip_address, reason, source_message=str(attempt.get("message") or ""))
        ban_label = ip_address
    delete_blocked_attempt(attempt.get("id"))
    status = admin_status()
    status["message"] = f"Banned {ban_label}."
    return jsonify(status)


@app.post("/api/admin/blocked-attempt/ignore")
def api_admin_blocked_attempt_ignore():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    attempt_id = payload.get("attemptId")
    if not blocked_attempt_by_id(attempt_id):
        return jsonify({"error": "Blocked attempt was not found."}), 404
    delete_blocked_attempt(attempt_id)
    return jsonify(admin_status())


@app.post("/api/admin/report/fixed")
def api_admin_report_fixed():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        resolve_message_report(payload.get("reportId"), "fixed", current_account().get("id"))
        status = admin_status()
        status["message"] = "Report marked fixed."
        return jsonify(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/report/ignore")
def api_admin_report_ignore():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        resolve_message_report(payload.get("reportId"), "ignored", current_account().get("id"))
        status = admin_status()
        status["message"] = "Report ignored."
        return jsonify(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/verify-account")
def api_admin_verify_account():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        verified = bool(payload.get("verified", True))
        account = set_account_verified(payload.get("accountId"), verified)
        status = admin_status()
        status["message"] = f"{'Verified' if verified else 'Unverified'} {account.get('username') or 'account'}."
        return jsonify(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/delete-account")
def api_admin_delete_account():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    account_id = payload.get("accountId")
    target = find_account_by_id(account_id)
    if not target:
        return jsonify({"error": "Account was not found."}), 404
    actor = current_account()
    if is_owner_account(target):
        return jsonify({"error": "The owner admin account cannot be deleted from the admin panel."}), 403
    if is_admin_account(target) and not is_owner_account(actor):
        return jsonify({"error": "Only the owner admin can delete admin accounts."}), 403
    delete_account(account_id)
    return jsonify(admin_status())


@app.post("/api/admin/grant-admin")
def api_admin_grant_admin():
    denied = require_owner_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        grant_admin_access(payload.get("accountId"), current_account().get("id"))
        return jsonify(admin_status())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/revoke-admin")
def api_admin_revoke_admin():
    denied = require_owner_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        revoke_admin_access(payload.get("accountId"))
        return jsonify(admin_status())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/profile-picture/approve")
def api_admin_profile_picture_approve():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        approve_profile_picture(payload.get("accountId"))
        return jsonify(admin_status())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/admin/profile-picture/decline")
def api_admin_profile_picture_decline():
    denied = require_admin()
    if denied:
        return denied
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    try:
        decline_profile_picture(payload.get("accountId"))
        return jsonify(admin_status())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/admin/blocked-attempts", methods=["GET", "OPTIONS"])
def api_admin_blocked_attempts():
    if request.method == "OPTIONS":
        return ("", 204)
    denied = require_admin()
    if denied:
        return denied
    include_all = request.args.get("all") == "1"
    return jsonify({"blockedAttempts": blocked_attempts(include_all)})


@app.post("/api/chat")
def api_chat():
    ip_address = client_ip()
    account = current_account()
    account_id = account.get("id") if account else None
    try:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}
        safe_record_request_event(ip_address)
        return jsonify(chat_response(payload, ip_address, account))
    except APIStatusError as exc:
        return jsonify({"reply": groq_error_message(exc)})
    except (APIConnectionError, APITimeoutError):
        refund_rate_limit(ip_address, account_id)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except urllib.error.HTTPError as exc:
        return jsonify({"reply": http_error_message(exc)})
    except urllib.error.URLError:
        refund_rate_limit(ip_address, account_id)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except TimeoutError:
        refund_rate_limit(ip_address, account_id)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except Exception:
        refund_rate_limit(ip_address, account_id)
        return jsonify({"reply": "Server error. Please try again later."})


def http_error_message(exc: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(exc.read().decode("utf-8"))
        detail = body.get("message") or body.get("error", {}).get("message", "")
    except Exception:
        detail = ""

    if is_backoff_error_message(detail) or exc.code in {413, 429}:
        return REQUEST_BACKOFF_MESSAGE
    if exc.code in {401, 403}:
        return "Internal server error"
    if exc.code == 404:
        return "Internal server error"
    return detail or f"The request failed with HTTP {exc.code}."


def is_backoff_error_message(message: str) -> bool:
    text = str(message or "").lower()
    return any(
        marker in text
        for marker in (
            "rate limit",
            "rate_limit",
            "request too large",
            "request is too large",
            "too large for model",
        )
    )


def groq_error_message(exc: APIStatusError) -> str:
    status_code = exc.status_code
    detail = ""
    try:
        body = exc.response.json()
        detail = body.get("message") or body.get("error", {}).get("message", "")
    except Exception:
        detail = str(exc)

    if status_code in {401, 403}:
        return "Internal server error"
    if status_code == 404:
        return "Internal server error"
    if is_backoff_error_message(detail) or status_code in {413, 429}:
        return REQUEST_BACKOFF_MESSAGE
    return detail or f"The request failed with HTTP {status_code}."


def main() -> None:
    load_dotenv()
    port = int(os.getenv("PORT") or os.getenv("AETHER_PORT", "8765"))
    host = os.getenv("AETHER_HOST", "0.0.0.0").strip() or "0.0.0.0"
    app.run(host=host, port=port)


if __name__ == "__main__":
    main()
