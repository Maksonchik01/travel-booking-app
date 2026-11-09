"""Ліміти запитів на клієнта (Redis, фіксоване вікно в годину).

Браузер ходить у API через сервер Next, тож `request.client` — це Vercel. Справжній IP веб
передає в `X-Client-IP`, і ми віримо йому лише разом із `X-Internal-Key` = INTERNAL_API_KEY.
Решта (прямі виклики API) — за IP з'єднання. Redis недоступний — пропускаємо: ліміт лише
захисна сітка, пошук через нього не ламаємо (graceful degradation).
"""

import hmac
import time
from collections.abc import Awaitable, Callable
from typing import Literal

import structlog
from fastapi import HTTPException, Request
from redis.asyncio import Redis

from tickets_api.core.config import Settings

log = structlog.get_logger(__name__)

Bucket = Literal["search", "ai", "auth", "clicks", "events"]
WINDOW_S = 3600


def client_id(request: Request, settings: Settings) -> str:
    forwarded = request.headers.get("x-client-ip")
    key = settings.internal_api_key
    if forwarded and key is not None:
        given = request.headers.get("x-internal-key", "")
        if hmac.compare_digest(given.encode(), key.get_secret_value().encode()):
            return forwarded.strip()[:64]
    return request.client.host if request.client else "unknown"


def limit_for(bucket: Bucket, settings: Settings) -> int:
    return {
        "search": settings.rate_limit_search_per_hour,
        "ai": settings.rate_limit_ai_per_hour,
        "auth": settings.rate_limit_auth_per_hour,
        "clicks": settings.rate_limit_clicks_per_hour,
        "events": settings.rate_limit_events_per_hour,
    }[bucket]


def rate_limit(bucket: Bucket) -> Callable[[Request], Awaitable[None]]:
    """Залежність FastAPI: понад ліміт — 429 з Retry-After."""

    async def dependency(request: Request) -> None:
        settings: Settings = request.app.state.settings
        redis: Redis = request.app.state.redis
        now = int(time.time())
        window = now // WINDOW_S
        key = f"rl:{bucket}:{client_id(request, settings)}:{window}"
        try:
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, WINDOW_S)
        except Exception as exc:
            log.warning("rate_limit.redis_failed", bucket=bucket, error=type(exc).__name__)
            return
        if count > limit_for(bucket, settings):
            retry_after = (window + 1) * WINDOW_S - now
            log.info("rate_limit.exceeded", bucket=bucket)
            raise HTTPException(
                status_code=429,
                detail="rate_limited",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency
