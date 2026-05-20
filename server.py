from __future__ import annotations

import json
import hashlib
import os
import re
import secrets
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from groq import APIConnectionError, APIStatusError, APITimeoutError, Groq

ROOT = Path(__file__).resolve().parent
PROFANITY_STORE_PATH = ROOT / "profanity.js"
REPORTS_STORE_PATH = ROOT / "reports.json"
ACCOUNTS_STORE_PATH = ROOT / "accounts.js"
ADMIN_MAC_ADDRESS = "10:FF:E0:3F:09:F5"
PROFANITY_LIMIT = 6
GUEST_RATE_LIMIT = 15
ACCOUNT_RATE_LIMIT = 30
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMITS: dict[str, dict] = {}
PROFANITY_PATTERNS = [
    re.compile(pattern, re.I)
    for pattern in [
        r"\bass\b",
        r"\basshole\b",
        r"\bbastard\b",
        r"\bbitch\b",
        r"\bcrap\b",
        r"\bdamn\b",
        r"\bfuck(?:er|ing)?\b",
        r"\bshit(?:ty)?\b",
        r"\bslut\b",
        r"\bwhore\b",
    ]
]
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


def default_profanity_store() -> dict:
    return {"warnedUsers": {}, "bannedUsers": {}, "bannedMacs": {}, "adminMacs": {}, "adminIps": {}}


def load_profanity_store() -> dict:
    if not PROFANITY_STORE_PATH.exists():
        store = default_profanity_store()
        save_profanity_store(store)
        return store

    text = PROFANITY_STORE_PATH.read_text(encoding="utf-8")
    match = re.search(r"window\.AETHER_PROFANITY_STORE\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not match:
        return default_profanity_store()
    try:
        store = json.loads(match.group(1))
    except json.JSONDecodeError:
        return default_profanity_store()
    store.setdefault("warnedUsers", {})
    store.setdefault("bannedUsers", {})
    store.setdefault("bannedMacs", {})
    store.setdefault("adminMacs", {})
    store.setdefault("adminIps", {})
    return store


def save_profanity_store(store: dict) -> None:
    body = json.dumps(store, indent=2, sort_keys=True)
    PROFANITY_STORE_PATH.write_text(f"window.AETHER_PROFANITY_STORE = {body};\n", encoding="utf-8")


def default_reports_store() -> dict:
    return {"reports": []}


def load_reports_store() -> dict:
    if not REPORTS_STORE_PATH.exists():
        store = default_reports_store()
        save_reports_store(store)
        return store
    try:
        store = json.loads(REPORTS_STORE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        store = default_reports_store()
    store.setdefault("reports", [])
    return store


def save_reports_store(store: dict) -> None:
    REPORTS_STORE_PATH.write_text(json.dumps(store, indent=2, sort_keys=True), encoding="utf-8")


def default_accounts_store() -> dict:
    return {"users": {}, "sessions": {}}


def load_accounts_store() -> dict:
    if not ACCOUNTS_STORE_PATH.exists():
        store = default_accounts_store()
        save_accounts_store(store)
        return store

    text = ACCOUNTS_STORE_PATH.read_text(encoding="utf-8")
    match = re.search(r"window\.AETHER_ACCOUNTS\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not match:
        return default_accounts_store()
    try:
        store = json.loads(match.group(1))
    except json.JSONDecodeError:
        return default_accounts_store()
    store.setdefault("users", {})
    store.setdefault("sessions", {})
    return store


def save_accounts_store(store: dict) -> None:
    body = json.dumps(store, indent=2, sort_keys=True)
    ACCOUNTS_STORE_PATH.write_text(f"window.AETHER_ACCOUNTS = {body};\n", encoding="utf-8")


def normalize_username(username: str) -> str:
    return re.sub(r"\s+", "", username.strip().lower())[:32]


def public_account(username: str, account: dict) -> dict:
    return {
        "username": username,
        "displayName": account.get("displayName") or username,
        "isAdmin": bool(account.get("isAdmin")),
        "createdAt": account.get("createdAt", ""),
        "lastLoginAt": account.get("lastLoginAt", ""),
    }


def hash_password(password: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()


def create_account(username: str, password: str, display_name: str = "") -> dict:
    username = normalize_username(username)
    if not username:
        raise ValueError("Enter a username.")
    if len(password) < 4:
        raise ValueError("Password must be at least 4 characters.")

    store = load_accounts_store()
    if username in store["users"]:
        raise ValueError("That username already exists.")

    now = datetime.now().astimezone().isoformat()
    salt = secrets.token_hex(16)
    store["users"][username] = {
        "displayName": display_name.strip()[:40] or username,
        "passwordSalt": salt,
        "passwordHash": hash_password(password, salt),
        "isAdmin": False,
        "createdAt": now,
        "lastLoginAt": "",
    }
    save_accounts_store(store)
    return public_account(username, store["users"][username])


def login_account(username: str, password: str) -> dict:
    username = normalize_username(username)
    store = load_accounts_store()
    account = store["users"].get(username)
    if not account or account.get("passwordHash") != hash_password(password, account.get("passwordSalt", "")):
        raise ValueError("Username or password is incorrect.")

    token = secrets.token_urlsafe(32)
    now = datetime.now().astimezone().isoformat()
    account["lastLoginAt"] = now
    store["sessions"][token] = {"username": username, "createdAt": now}
    save_accounts_store(store)
    return {"session": token, "account": public_account(username, account)}


def account_for_session(session_token: str) -> tuple[str, dict] | tuple[None, None]:
    if not session_token:
        return None, None
    store = load_accounts_store()
    session = store["sessions"].get(session_token)
    if not session:
        return None, None
    username = session.get("username", "")
    account = store["users"].get(username)
    if not account:
        return None, None
    return username, account


def logout_account(session_token: str) -> None:
    store = load_accounts_store()
    store["sessions"].pop(session_token, None)
    save_accounts_store(store)


def set_account_admin(username: str, is_admin: bool) -> dict:
    username = normalize_username(username)
    store = load_accounts_store()
    account = store["users"].get(username)
    if not account:
        raise ValueError("Account not found.")
    account["isAdmin"] = bool(is_admin)
    account["adminUpdatedAt"] = datetime.now().astimezone().isoformat()
    save_accounts_store(store)
    return public_account(username, account)


def delete_account(username: str) -> bool:
    username = normalize_username(username)
    store = load_accounts_store()
    existed = username in store["users"]
    store["users"].pop(username, None)
    store["sessions"] = {
        token: session for token, session in store["sessions"].items() if session.get("username") != username
    }
    save_accounts_store(store)
    return existed


def contains_profanity(message: str) -> bool:
    return any(pattern.search(message) for pattern in PROFANITY_PATTERNS)


def profanity_status_for_ip(ip_address: str, message: str) -> dict | None:
    store = load_profanity_store()
    ban = ban_status_for_ip(ip_address)
    if ban["banned"]:
        return {"warnings": int(ban.get("warnings", PROFANITY_LIMIT)), "banned": True}

    if not contains_profanity(message):
        return None

    now = datetime.now().astimezone().isoformat()
    warned = store["warnedUsers"].get(ip_address, {})
    warnings = int(warned.get("warnings", 0)) + 1
    store["warnedUsers"][ip_address] = {"warnings": warnings, "updatedAt": now}

    banned = warnings >= PROFANITY_LIMIT
    if banned:
        store["bannedUsers"][ip_address] = {"warnings": warnings, "bannedAt": now}

    save_profanity_store(store)
    return {"warnings": warnings, "banned": banned}


def ban_status_for_ip(ip_address: str) -> dict:
    store = load_profanity_store()
    if ip_address in store["bannedUsers"]:
        banned = store["bannedUsers"][ip_address]
        return {
            "banned": True,
            "type": "ip",
            "warnings": int(banned.get("warnings", PROFANITY_LIMIT)),
            "reason": banned.get("reason", ""),
        }
    mac_address = mac_for_ip(ip_address)
    if mac_address and mac_address in store["bannedMacs"]:
        banned = store["bannedMacs"][mac_address]
        return {
            "banned": True,
            "type": "mac",
            "warnings": PROFANITY_LIMIT,
            "reason": banned.get("reason", ""),
        }
    return {"banned": False}


def ban_ip_address(ip_address: str, reason: str = "Admin ban") -> None:
    store = load_profanity_store()
    now = datetime.now().astimezone().isoformat()
    store["bannedUsers"][ip_address] = {
        "warnings": PROFANITY_LIMIT,
        "bannedAt": now,
        "reason": reason,
    }
    save_profanity_store(store)


def ban_mac_address(mac_address: str, reason: str = "Admin MAC ban") -> str:
    normalized_mac = normalize_mac(mac_address)
    if not normalized_mac:
        raise ValueError("Missing MAC address.")
    if normalized_mac == normalize_mac(ADMIN_MAC_ADDRESS):
        raise ValueError("Cannot ban the configured admin MAC address.")
    store = load_profanity_store()
    store["bannedMacs"][normalized_mac] = {
        "bannedAt": datetime.now().astimezone().isoformat(),
        "reason": reason,
    }
    save_profanity_store(store)
    return normalized_mac


def unban_ip_address(ip_address: str) -> None:
    store = load_profanity_store()
    store["bannedUsers"].pop(ip_address, None)
    save_profanity_store(store)


def unban_mac_address(mac_address: str) -> str:
    normalized_mac = normalize_mac(mac_address)
    store = load_profanity_store()
    store["bannedMacs"].pop(normalized_mac, None)
    save_profanity_store(store)
    return normalized_mac


def reset_ip_warnings(ip_address: str) -> None:
    store = load_profanity_store()
    store["warnedUsers"].pop(ip_address, None)
    save_profanity_store(store)


def grant_admin_mac(mac_address: str, note: str = "Granted by admin") -> str:
    normalized_mac = normalize_mac(mac_address)
    if not normalized_mac:
        raise ValueError("Missing MAC address.")
    store = load_profanity_store()
    store["adminMacs"][normalized_mac] = {
        "grantedAt": datetime.now().astimezone().isoformat(),
        "note": note,
    }
    store["bannedMacs"].pop(normalized_mac, None)
    save_profanity_store(store)
    return normalized_mac


def grant_admin_ip(ip_address: str, note: str = "Granted by admin") -> str:
    ip_address = ip_address.strip()
    if not ip_address:
        raise ValueError("Missing IP address.")
    store = load_profanity_store()
    store["adminIps"][ip_address] = {
        "grantedAt": datetime.now().astimezone().isoformat(),
        "note": note,
    }
    store["bannedUsers"].pop(ip_address, None)
    save_profanity_store(store)
    return ip_address


def revoke_admin_mac(mac_address: str) -> str:
    normalized_mac = normalize_mac(mac_address)
    if normalized_mac == normalize_mac(ADMIN_MAC_ADDRESS):
        raise ValueError("Cannot revoke the primary admin MAC address.")
    store = load_profanity_store()
    store["adminMacs"].pop(normalized_mac, None)
    save_profanity_store(store)
    return normalized_mac


def revoke_admin_ip(ip_address: str) -> str:
    ip_address = ip_address.strip()
    store = load_profanity_store()
    store["adminIps"].pop(ip_address, None)
    save_profanity_store(store)
    return ip_address


def normalize_mac(value: str) -> str:
    parts = re.findall(r"[0-9a-fA-F]{2}", value)
    return ":".join(part.upper() for part in parts)


def local_mac_addresses() -> set[str]:
    try:
        result = subprocess.run(
            ["getmac", "/fo", "csv", "/nh"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
    except Exception:
        return set()
    return {normalize_mac(match.group(0)) for match in re.finditer(r"(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}", result.stdout)}


def local_network_ips() -> list[str]:
    ips: set[str] = set()
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def mac_for_ip(ip_address: str) -> str:
    if ip_address in {"127.0.0.1", "::1"}:
        return normalize_mac(ADMIN_MAC_ADDRESS)

    try:
        result = subprocess.run(
            ["arp", "-a", ip_address],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
    except Exception:
        return ""
    match = re.search(r"(?:[0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}", result.stdout)
    return normalize_mac(match.group(0)) if match else ""


def is_admin_request(ip_address: str, session_token: str = "") -> bool:
    store = load_profanity_store()
    client_mac = mac_for_ip(ip_address)
    _, account = account_for_session(session_token)
    return (
        client_mac == normalize_mac(ADMIN_MAC_ADDRESS)
        or client_mac in store.get("adminMacs", {})
        or ip_address in store.get("adminIps", {})
        or bool(account and account.get("isAdmin"))
    )


def rate_limit_key(ip_address: str, session_token: str = "") -> str:
    username, account = account_for_session(session_token)
    if account:
        return f"account:{username}"
    client_mac = mac_for_ip(ip_address)
    if client_mac:
        return f"mac:{client_mac}"
    return f"ip:{ip_address}"


def rate_limit_for_request(ip_address: str, session_token: str = "") -> int | None:
    if is_admin_request(ip_address, session_token):
        return None
    _, account = account_for_session(session_token)
    return ACCOUNT_RATE_LIMIT if account else GUEST_RATE_LIMIT


def rate_limit_status(ip_address: str, session_token: str = "") -> dict:
    limit = rate_limit_for_request(ip_address, session_token)
    if limit is None:
        return {
            "limit": None,
            "used": 0,
            "remaining": None,
            "percentUsed": 0,
            "resetInSeconds": 0,
            "unlimited": True,
        }

    now = datetime.now().astimezone()
    key = rate_limit_key(ip_address, session_token)
    bucket = RATE_LIMITS.get(key)
    if not bucket or bucket["resetAt"] <= now:
        bucket = {"count": 0, "resetAt": now + timedelta(seconds=RATE_LIMIT_WINDOW_SECONDS)}
        RATE_LIMITS[key] = bucket

    used = int(bucket["count"])
    remaining = max(0, limit - used)
    reset_in = max(0, int((bucket["resetAt"] - now).total_seconds()))
    return {
        "limit": limit,
        "used": used,
        "remaining": remaining,
        "percentUsed": round((used / limit) * 100) if limit else 0,
        "resetInSeconds": reset_in,
        "unlimited": False,
    }


def consume_rate_limit(ip_address: str, session_token: str = "") -> dict:
    status = rate_limit_status(ip_address, session_token)
    if status["unlimited"]:
        return {"allowed": True, "rateLimit": status}
    if status["remaining"] <= 0:
        return {"allowed": False, "rateLimit": status}

    key = rate_limit_key(ip_address, session_token)
    RATE_LIMITS[key]["count"] = int(RATE_LIMITS[key]["count"]) + 1
    return {"allowed": True, "rateLimit": rate_limit_status(ip_address, session_token)}


def reset_all_rate_limits() -> None:
    RATE_LIMITS.clear()


def submit_report(payload: dict, ip_address: str, session_token: str = "") -> dict:
    now = datetime.now().astimezone().isoformat()
    username, _ = account_for_session(session_token)
    report = {
        "id": str(uuid4()),
        "status": "open",
        "createdAt": now,
        "reporterIp": ip_address,
        "reporterMac": mac_for_ip(ip_address),
        "reporterUsername": username or "",
        "reason": str(payload.get("reason", "Other")).strip()[:120],
        "details": str(payload.get("details", "")).strip()[:1000],
        "messageId": str(payload.get("messageId", "")).strip()[:120],
        "messageContent": str(payload.get("messageContent", "")).strip()[:4000],
        "chatId": str(payload.get("chatId", "")).strip()[:120],
        "chatTitle": str(payload.get("chatTitle", "")).strip()[:200],
    }
    store = load_reports_store()
    store["reports"].insert(0, report)
    save_reports_store(store)
    return report


def admin_payload(ip_address: str) -> dict:
    reports = load_reports_store()["reports"]
    profanity = load_profanity_store()
    accounts = load_accounts_store()
    open_reports = [report for report in reports if report.get("status") == "open"]
    unique_reporters = sorted({report.get("reporterIp", "") for report in reports if report.get("reporterIp")})
    recent_macs = sorted({report.get("reporterMac", "") for report in reports if report.get("reporterMac")})
    return {
        "reports": reports,
        "bannedUsers": profanity.get("bannedUsers", {}),
        "bannedMacs": profanity.get("bannedMacs", {}),
        "warnedUsers": profanity.get("warnedUsers", {}),
        "accounts": [
            public_account(username, account)
            for username, account in sorted(accounts.get("users", {}).items())
        ],
        "adminMacs": {
            normalize_mac(ADMIN_MAC_ADDRESS): {
                "grantedAt": "primary",
                "note": "Primary admin",
                "primary": True,
            },
            **profanity.get("adminMacs", {}),
        },
        "adminIps": profanity.get("adminIps", {}),
        "stats": {
            "totalReports": len(reports),
            "openReports": len(open_reports),
            "ignoredReports": len(reports) - len(open_reports),
            "bannedUsers": len(profanity.get("bannedUsers", {})),
            "bannedMacs": len(profanity.get("bannedMacs", {})),
            "warnedUsers": len(profanity.get("warnedUsers", {})),
            "uniqueReporters": len(unique_reporters),
            "adminMacs": len(profanity.get("adminMacs", {})) + 1,
            "adminIps": len(profanity.get("adminIps", {})),
            "accounts": len(accounts.get("users", {})),
            "adminAccounts": len([account for account in accounts.get("users", {}).values() if account.get("isAdmin")]),
        },
        "client": {
            "ip": ip_address,
            "mac": mac_for_ip(ip_address),
        },
        "recent": {
            "ips": unique_reporters[-25:],
            "macs": recent_macs[-25:],
        },
    }


def update_report_status(report_id: str, status: str) -> dict | None:
    store = load_reports_store()
    for report in store["reports"]:
        if report.get("id") == report_id:
            report["status"] = status
            report["reviewedAt"] = datetime.now().astimezone().isoformat()
            save_reports_store(store)
            return report
    return None


def delete_report(report_id: str) -> bool:
    store = load_reports_store()
    before = len(store["reports"])
    store["reports"] = [report for report in store["reports"] if report.get("id") != report_id]
    save_reports_store(store)
    return len(store["reports"]) != before


def clear_reports(status: str | None = None) -> int:
    store = load_reports_store()
    before = len(store["reports"])
    if status:
        store["reports"] = [report for report in store["reports"] if report.get("status") != status]
    else:
        store["reports"] = []
    save_reports_store(store)
    return before - len(store["reports"])


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


def groq_completion_with_fallback(model: str, messages: list[dict]) -> str:
    keys = groq_api_keys()
    if not keys:
        return "Add GROQ_API_KEY or GROQ_API_KEYS to .env, restart server.py, then try again."

    last_rate_limit_error = None
    for api_key in keys:
        try:
            client = Groq(api_key=api_key)
            completion = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.6,
                max_completion_tokens=4096,
                top_p=0.95,
                reasoning_effort="low",
                stream=True,
                stop=None,
            )

            chunks = []
            for chunk in completion:
                content = chunk.choices[0].delta.content or ""
                if content:
                    chunks.append(content)

            reply = "".join(chunks).strip()
            return reply or "I could not read a response from the model."
        except APIStatusError as exc:
            if exc.status_code == 429:
                last_rate_limit_error = exc
                continue
            raise

    if last_rate_limit_error:
        raise last_rate_limit_error
    return "I could not read a response from the model."


def groq_reply(message: str, chat: list[dict]) -> str:
    model = os.getenv("AETHER_GROQ_MODEL", "qwen/qwen3-32b").strip()

    now = datetime.now().astimezone().strftime("%A, %B %d, %Y at %I:%M %p %Z")
    messages = [
        {
            "role": "system",
            "content": (
                "You are Aether AI, a friendly web assistant. "
                f"The user's current system time is {now}. "
                "Keep replies natural and useful. Do not mention providers, tokens, API calls, "
                "or implementation details. Reply in plain text only. Do not use Markdown syntax. "
                "Do not use bold, italics, headings, tables, code fences, bullet markdown, or asterisks for emphasis."
            ),
        }
    ]
    for item in chat[-20:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})

    if not any(item["role"] == "user" and item["content"] == message for item in messages):
        messages.append({"role": "user", "content": message})

    return groq_completion_with_fallback(model, messages)


def looks_like_weather_request(message: str) -> bool:
    return bool(re.search(r"\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|hot|cold)\b", message, re.I))


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


class AetherHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Aether-Session")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/admin/status":
            username, account = account_for_session(self.session_token())
            is_admin = is_admin_request(self.client_address[0], self.session_token())
            ban = ban_status_for_ip(self.client_address[0])
            self.send_json(
                {
                    "isAdmin": is_admin,
                    "clientIp": self.client_address[0],
                    "clientMac": mac_for_ip(self.client_address[0]) if is_admin else "",
                    "account": public_account(username, account) if account else None,
                    "ban": ban,
                    "rateLimit": rate_limit_status(self.client_address[0], self.session_token()),
                }
            )
            return

        if self.path == "/api/admin/reports":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            self.send_json(admin_payload(self.client_address[0]))
            return

        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/account/register":
            try:
                payload = self.read_json_body()
                account = create_account(
                    str(payload.get("username", "")),
                    str(payload.get("password", "")),
                    str(payload.get("displayName", "")),
                )
                self.send_json({"ok": True, "account": account})
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/account/login":
            try:
                payload = self.read_json_body()
                self.send_json(
                    {
                        "ok": True,
                        **login_account(str(payload.get("username", "")), str(payload.get("password", ""))),
                    }
                )
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/account/logout":
            logout_account(self.session_token())
            self.send_json({"ok": True})
            return

        if self.path == "/api/account/status":
            username, account = account_for_session(self.session_token())
            self.send_json({"account": public_account(username, account) if account else None})
            return

        if self.path == "/api/report":
            try:
                report = submit_report(self.read_json_body(), self.client_address[0], self.session_token())
                self.send_json({"ok": True, "report": report})
            except Exception as exc:
                self.send_json({"ok": False, "error": f"Report error: {exc}"}, status=200)
            return

        if self.path == "/api/admin/report":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            report = update_report_status(str(payload.get("reportId", "")), str(payload.get("status", "ignored")))
            if not report:
                self.send_json({"error": "Report not found."}, status=404)
                return
            self.send_json({"ok": True, "report": report})
            return

        if self.path == "/api/admin/ban":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            ip_address = str(payload.get("ip", "")).strip()
            if not ip_address:
                self.send_json({"error": "Missing IP address."}, status=400)
                return
            ban_ip_address(ip_address, str(payload.get("reason", "Admin ban")).strip() or "Admin ban")
            self.send_json({"ok": True, "ip": ip_address})
            return

        if self.path == "/api/admin/ban-mac":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            try:
                mac_address = ban_mac_address(
                    str(payload.get("mac", "")).strip(),
                    str(payload.get("reason", "Admin MAC ban")).strip() or "Admin MAC ban",
                )
                self.send_json({"ok": True, "mac": mac_address})
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/admin/unban":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            ip_address = str(payload.get("ip", "")).strip()
            if not ip_address:
                self.send_json({"error": "Missing IP address."}, status=400)
                return
            unban_ip_address(ip_address)
            self.send_json({"ok": True, "ip": ip_address})
            return

        if self.path == "/api/admin/unban-mac":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            mac_address = unban_mac_address(str(payload.get("mac", "")).strip())
            self.send_json({"ok": True, "mac": mac_address})
            return

        if self.path == "/api/admin/reset-warnings":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            ip_address = str(payload.get("ip", "")).strip()
            if not ip_address:
                self.send_json({"error": "Missing IP address."}, status=400)
                return
            reset_ip_warnings(ip_address)
            self.send_json({"ok": True, "ip": ip_address})
            return

        if self.path == "/api/admin/grant":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            note = str(payload.get("note", "Granted by admin")).strip() or "Granted by admin"
            try:
                if str(payload.get("type", "")).lower() == "ip":
                    value = grant_admin_ip(str(payload.get("value", "")).strip(), note)
                    self.send_json({"ok": True, "type": "ip", "value": value})
                else:
                    value = grant_admin_mac(str(payload.get("value", "")).strip(), note)
                    self.send_json({"ok": True, "type": "mac", "value": value})
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/admin/revoke":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            try:
                if str(payload.get("type", "")).lower() == "ip":
                    value = revoke_admin_ip(str(payload.get("value", "")).strip())
                    self.send_json({"ok": True, "type": "ip", "value": value})
                else:
                    value = revoke_admin_mac(str(payload.get("value", "")).strip())
                    self.send_json({"ok": True, "type": "mac", "value": value})
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/admin/account-admin":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            try:
                account = set_account_admin(str(payload.get("username", "")), bool(payload.get("isAdmin")))
                self.send_json({"ok": True, "account": account})
            except ValueError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if self.path == "/api/admin/delete-account":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            self.send_json({"ok": delete_account(str(payload.get("username", "")))})
            return

        if self.path == "/api/admin/delete-report":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            deleted = delete_report(str(payload.get("reportId", "")))
            self.send_json({"ok": deleted})
            return

        if self.path == "/api/admin/clear-reports":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            payload = self.read_json_body()
            status = str(payload.get("status", "")).strip() or None
            self.send_json({"ok": True, "deleted": clear_reports(status)})
            return

        if self.path == "/api/admin/reset-rate-limits":
            if not is_admin_request(self.client_address[0], self.session_token()):
                self.send_json({"error": "Admin access required."}, status=403)
                return
            reset_all_rate_limits()
            self.send_json({"ok": True})
            return

        if self.path != "/api/chat":
            self.send_json({"error": "Not found"}, status=404)
            return

        try:
            payload = self.read_json_body()
            message = str(payload.get("message", "")).strip()
            chat = payload.get("chat") if isinstance(payload.get("chat"), list) else []
            location = payload.get("location")
            if not message:
                self.send_json({"reply": "Send a message first."})
                return
            ban = ban_status_for_ip(self.client_address[0])
            if ban["banned"]:
                self.send_json(
                    {
                        "reply": "You are permanently banned from Aether AI for breaking the TOS.",
                        "ban": ban,
                    }
                )
                return
            warning = profanity_status_for_ip(self.client_address[0], message)
            if warning:
                reply = (
                    "You are permanently banned from Aether AI for breaking the TOS."
                    if warning["banned"]
                    else "Profanity warning."
                )
                self.send_json({"reply": reply, "warning": warning})
                return
            rate = consume_rate_limit(self.client_address[0], self.session_token())
            if not rate["allowed"]:
                self.send_json(
                    {
                        "reply": "Rate limit reached. Wait for the next minute or sign in for a higher limit.",
                        "rateLimited": True,
                        "rateLimit": rate["rateLimit"],
                    }
                )
                return
            if location and looks_like_weather_request(message):
                latitude, longitude = coordinates_from_location(location)
                reply = weather_reply(latitude, longitude)
                self.send_json({"reply": reply, "rateLimit": rate["rateLimit"]})
                return
            reply = groq_reply(message, chat)
            self.send_json({"reply": reply, "rateLimit": rate["rateLimit"]})
        except APIStatusError as exc:
            self.send_json({"reply": groq_error_message(exc)}, status=200)
        except (APIConnectionError, APITimeoutError):
            self.send_json({"reply": "I could not connect to Groq. Check your internet connection."}, status=200)
        except urllib.error.HTTPError as exc:
            self.send_json({"reply": http_error_message(exc)}, status=200)
        except urllib.error.URLError:
            self.send_json({"reply": "I could not connect to the weather service. Check your internet connection."}, status=200)
        except TimeoutError:
            self.send_json({"reply": "The model request timed out. Try again."}, status=200)
        except Exception as exc:
            self.send_json({"reply": f"Server error: {exc}"}, status=200)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if not body:
            return {}
        payload = json.loads(body.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    def session_token(self) -> str:
        return self.headers.get("X-Aether-Session", "").strip()

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def http_error_message(exc: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(exc.read().decode("utf-8"))
        detail = body.get("message") or body.get("error", {}).get("message", "")
    except Exception:
        detail = ""

    if exc.code in {401, 403}:
        return "The weather service rejected the request."
    if exc.code == 404:
        return "The weather endpoint was not found."
    if exc.code == 429:
        return "The account is rate limited or out of quota. Try again later."
    return detail or f"The request failed with HTTP {exc.code}."


def groq_error_message(exc: APIStatusError) -> str:
    status_code = exc.status_code
    detail = ""
    try:
        body = exc.response.json()
        detail = body.get("message") or body.get("error", {}).get("message", "")
    except Exception:
        detail = str(exc)

    if status_code in {401, 403}:
        return "The Groq API key was rejected. Check GROQ_API_KEY in .env."
    if status_code == 404:
        return "The selected Groq model was not found. Check AETHER_GROQ_MODEL."
    if status_code == 429:
        return "The Groq account is rate limited or out of quota. Try again later."
    return detail or f"The Groq request failed with HTTP {status_code}."


def main() -> None:
    load_dotenv()
    port = int(os.getenv("AETHER_PORT", "8765"))
    host = os.getenv("AETHER_HOST", "0.0.0.0").strip() or "0.0.0.0"
    server = ThreadingHTTPServer((host, port), AetherHandler)
    print(f"Aether AI listening on {host}:{port}")
    print(f"Open locally: http://127.0.0.1:{port}/")
    for ip in local_network_ips():
        print(f"Open from phone on same Wi-Fi: http://{ip}:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
