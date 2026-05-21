from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from groq import APIConnectionError, APIStatusError, APITimeoutError, Groq

ROOT = Path(__file__).resolve().parent
PROFANITY_BLOCK_MESSAGE = "You cant send Aether a message with profanity in it. You can try again without profanity in your message."
GUEST_RATE_LIMIT = 300
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMITS: dict[str, dict] = {}
app = Flask(__name__, static_folder=str(ROOT), static_url_path="")
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


def contains_profanity(message: str) -> bool:
    return any(pattern.search(message) for pattern in PROFANITY_PATTERNS)

def rate_limit_key() -> str:
    return "global"


def rate_limit_for_request() -> int:
    return GUEST_RATE_LIMIT


def rate_limit_status(ip_address: str | None = None) -> dict:
    limit = rate_limit_for_request()
    now = datetime.now().astimezone()
    key = rate_limit_key()
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

    key = rate_limit_key()
    RATE_LIMITS[key]["count"] = int(RATE_LIMITS[key]["count"]) + 1
    return {"allowed": True, "rateLimit": rate_limit_status(ip_address)}


def refund_rate_limit(ip_address: str) -> None:
    key = rate_limit_key()
    bucket = RATE_LIMITS.get(key)
    if not bucket:
        return
    bucket["count"] = max(0, int(bucket.get("count", 0)) - 1)


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


def groq_models() -> list[str]:
    candidates = []
    configured_models = os.getenv("AETHER_GROQ_MODELS", "").strip()
    if configured_models:
        candidates.extend(re.split(r"[\s,;]+", configured_models))

    configured_model = os.getenv("AETHER_GROQ_MODEL", "").strip()
    if configured_model:
        candidates.append(configured_model)

    candidates.append("llama-3.1-8b-instant")

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


def groq_reply(message: str, chat: list[dict]) -> str:
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

    return groq_completion_with_fallback(messages)


def looks_like_weather_request(message: str) -> bool:
    return bool(re.search(r"\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|hot|cold)\b", message, re.I))


def looks_like_location_time_request(message: str) -> bool:
    return bool(re.search(r"\bwhat\b", message, re.I) and re.search(r"\btime\b", message, re.I))


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

    current = data.get("current") if isinstance(data.get("current"), dict) else {}
    current_time = current.get("time")
    timezone_name = data.get("timezone") or "UTC"
    offset_seconds = int(data.get("utc_offset_seconds") or 0)
    try:
        now = datetime.fromisoformat(current_time) if current_time else datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    except Exception:
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
        return forwarded_for.split(",", 1)[0].strip()
    return request.remote_addr or "127.0.0.1"


def chat_response(payload: dict, ip_address: str) -> dict:
    message = str(payload.get("message", "")).strip()
    chat = payload.get("chat") if isinstance(payload.get("chat"), list) else []
    location = payload.get("location")
    if not message:
        return {"reply": "Send a message first."}
    if contains_profanity(message):
        return {"reply": PROFANITY_BLOCK_MESSAGE, "profanityBlocked": True}
    if looks_like_location_time_request(message) and not location:
        return {"reply": "Accept Aether's permission to view your location to see what timezone you are in."}
    rate = consume_rate_limit(ip_address)
    if not rate["allowed"]:
        return {
            "reply": "Rate limit reached. Wait up to 1 minute.",
            "rateLimited": True,
            "rateLimit": rate["rateLimit"],
        }
    if location and looks_like_location_time_request(message):
        latitude, longitude = coordinates_from_location(location)
        reply = location_time_reply(latitude, longitude)
        return {"reply": reply, "rateLimit": rate["rateLimit"]}
    if location and looks_like_weather_request(message):
        latitude, longitude = coordinates_from_location(location)
        reply = weather_reply(latitude, longitude)
        return {"reply": reply, "rateLimit": rate["rateLimit"]}
    reply = groq_reply(message, chat)
    return {"reply": reply, "rateLimit": rate["rateLimit"]}


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/status")
def api_status():
    return jsonify(
        {
            "rateLimit": rate_limit_status(),
        }
    )


@app.route("/api/admin/status", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/report", methods=["GET", "POST", "OPTIONS"])
def removed_endpoints():
    return jsonify({"error": "Not found"}), 404


@app.post("/api/chat")
def api_chat():
    ip_address = client_ip()
    try:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}
        return jsonify(chat_response(payload, ip_address))
    except APIStatusError as exc:
        return jsonify({"reply": groq_error_message(exc)})
    except (APIConnectionError, APITimeoutError):
        refund_rate_limit(ip_address)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except urllib.error.HTTPError as exc:
        return jsonify({"reply": http_error_message(exc)})
    except urllib.error.URLError:
        refund_rate_limit(ip_address)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except TimeoutError:
        refund_rate_limit(ip_address)
        return jsonify({"retryable": True, "retryAfterSeconds": 4})
    except Exception as exc:
        return jsonify({"reply": f"Server error: {exc}"})


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
    app.run(host=host, port=port)


if __name__ == "__main__":
    main()



