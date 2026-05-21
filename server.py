from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from groq import APIConnectionError, APIStatusError, APITimeoutError, Groq

ROOT = Path(__file__).resolve().parent
PROFANITY_STORE_PATH = ROOT / "profanity.js"
PROFANITY_LIMIT = 6
GUEST_RATE_LIMIT = 5
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
    return {"warnedUsers": {}, "bannedUsers": {}}


def load_profanity_store() -> dict:
    changed = False
    if not PROFANITY_STORE_PATH.exists():
        store = default_profanity_store()
        body = json.dumps(store, indent=2, sort_keys=True)
        PROFANITY_STORE_PATH.write_text(f"window.AETHER_PROFANITY_STORE = {body};\n", encoding="utf-8")
    else:
        text = PROFANITY_STORE_PATH.read_text(encoding="utf-8")
        match = re.search(r"window\.AETHER_PROFANITY_STORE\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
        if not match:
            store = default_profanity_store()
        else:
            try:
                store = json.loads(match.group(1))
            except json.JSONDecodeError:
                store = default_profanity_store()

    store.setdefault("warnedUsers", {})
    store.setdefault("bannedUsers", {})
    if changed:
        save_profanity_store(store)
    return store


def save_profanity_store(store: dict) -> None:
    body = json.dumps(store, indent=2, sort_keys=True)
    PROFANITY_STORE_PATH.write_text(f"window.AETHER_PROFANITY_STORE = {body};\n", encoding="utf-8")


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
    return {"banned": False}

def rate_limit_key(ip_address: str) -> str:
    return f"ip:{ip_address}"


def rate_limit_for_request(ip_address: str) -> int:
    return GUEST_RATE_LIMIT


def rate_limit_status(ip_address: str) -> dict:
    limit = rate_limit_for_request(ip_address)
    now = datetime.now().astimezone()
    key = rate_limit_key(ip_address)
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
    }


def consume_rate_limit(ip_address: str) -> dict:
    status = rate_limit_status(ip_address)
    if status["remaining"] <= 0:
        return {"allowed": False, "rateLimit": status}

    key = rate_limit_key(ip_address)
    RATE_LIMITS[key]["count"] = int(RATE_LIMITS[key]["count"]) + 1
    return {"allowed": True, "rateLimit": rate_limit_status(ip_address)}


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
        return "I need a quick setup fix before I can answer."

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
            return reply or "I could not read a response."
        except APIStatusError as exc:
            if exc.status_code == 429:
                last_rate_limit_error = exc
                continue
            raise

    if last_rate_limit_error:
        raise last_rate_limit_error
    return "I could not read a response."


def groq_reply(message: str, chat: list[dict]) -> str:
    model = os.getenv("AETHER_GROQ_MODEL", "qwen/qwen3-32b").strip()

    now = datetime.now().astimezone().strftime("%A, %B %d, %Y at %I:%M %p %Z")
    messages = [
        {
            "role": "system",
            "content": (
                "You are Aether, a friendly web assistant. "
                f"The user's current system time is {now}. "
                "Always be friendly. Keep responses as short as possible while still answering clearly. "
                "Never mention GPT, ChatGPT, OpenAI, AI, providers, sources, tokens, API calls, "
                "models, or implementation details. Reply in plain text only. Do not use Markdown syntax. "
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/status":
            self.send_json(
                {
                    "ban": ban_status_for_ip(self.client_address[0]),
                    "rateLimit": rate_limit_status(self.client_address[0]),
                }
            )
            return

        super().do_GET()

    def do_POST(self) -> None:
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
                        "reply": "You are permanently banned from Aether for breaking the TOS.",
                        "ban": ban,
                    }
                )
                return
            warning = profanity_status_for_ip(self.client_address[0], message)
            if warning:
                reply = (
                    "You are permanently banned from Aether for breaking the TOS."
                    if warning["banned"]
                    else "Profanity warning."
                )
                self.send_json({"reply": reply, "warning": warning})
                return
            rate = consume_rate_limit(self.client_address[0])
            if not rate["allowed"]:
                self.send_json(
                    {
                        "reply": "Rate limit reached. Wait up to 5 minutes.",
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
            self.send_json({"reply": "I could not connect right now. Check your internet connection."}, status=200)
        except urllib.error.HTTPError as exc:
            self.send_json({"reply": http_error_message(exc)}, status=200)
        except urllib.error.URLError:
            self.send_json({"reply": "I could not connect to the weather service. Check your internet connection."}, status=200)
        except TimeoutError:
            self.send_json({"reply": "That took too long. Try again."}, status=200)
        except Exception as exc:
            self.send_json({"reply": f"Server error: {exc}"}, status=200)
    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if not body:
            return {}
        payload = json.loads(body.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

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
        return "Internal server error"
    if exc.code == 404:
        return "Internal server error"
    if exc.code == 429:
        return "Something went wrong, please try again later. :("
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
        return "Internal server error"
    if status_code == 404:
        return "Internal server error"
    if status_code == 429:
        return "Something went wrong, please try again later. :("
    return detail or f"The request failed with HTTP {status_code}."


def main() -> None:
    load_dotenv()
    port = int(os.getenv("PORT") or os.getenv("AETHER_PORT", "8765"))
    host = os.getenv("AETHER_HOST", "0.0.0.0").strip() or "0.0.0.0"
    server = ThreadingHTTPServer((host, port), AetherHandler)
    print(f"Server active.")
    server.serve_forever()


if __name__ == "__main__":
    main()



