"""Ліміти запитів на клієнта (Redis, фіксоване вікно в годину) і одночасних пошуків.

Браузер ходить у API через сервер Next, тож `request.client` — це Vercel. Справжній IP веб
передає в `X-Client-IP`, і ми віримо йому лише разом із `X-Internal-Key` = INTERNAL_API_KEY.
Решта (прямі виклики API) — за IP з'єднання. Redis недоступний — пропускаємо: ліміт лише
захисна сітка, пошук через нього не ламаємо (graceful degradation).

Кошики (ADR 0056) — за вартістю операції, а не одним «search» на все:
`search` — пошук перельотів, житла, Explore; `heavy` — поїздка (переліт + житло), «знайти
дешевше», оновлення цін; `check` — перевірка продавців і тарифів; `lookup` — дешеві читання
(календар, матриця, історія цін, місця, публічна поїздка). Увійшов — власний кошик акаунта з
більшим лімітом (`rate_limit_account_multiplier`); токен перевіряємо, підробка — кошик IP.
"""

import contextlib
import hashlib
import hmac
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

import structlog
from fastapi import HTTPException, Request
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.core.config import Settings

log = structlog.get_logger(__name__)

Bucket = Literal["search", "heavy", "check", "lookup", "ai", "auth", "clicks", "events"]
WINDOW_S = 3600
IDENTITY_TTL_S = 300
CONCURRENCY_TTL_S = 180
"""Запас на випадок, якщо процес упав посеред пошуку й лічильник не зменшився."""
ACCOUNT_BUCKETS: frozenset[Bucket] = frozenset({"search", "heavy", "check", "lookup", "ai"})


def client_id(request: Request, settings: Settings) -> str:
    forwarded = request.headers.get("x-client-ip")
    key = settings.internal_api_key
    if forwarded and key is not None:
        given = request.headers.get("x-internal-key", "")
        if hmac.compare_digest(given.encode(), key.get_secret_value().encode()):
            return forwarded.strip()[:64]
    return request.client.host if request.client else "unknown"


async def account_id(request: Request, redis: Redis) -> str | None:
    """Акаунт за `Authorization: Bearer` (веб передає сесію з cookie); перевірений, із кешем
    у Redis на 5 хв. Невідомий токен — None (кошик IP), щоб підробкою не обійти ліміт."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or len(auth) > 512:
        return None
    token = auth.removeprefix("Bearer ").strip()
    cache_key = f"rl:who:{hashlib.sha256(token.encode()).hexdigest()[:32]}"
    try:
        cached = await redis.get(cache_key)
    except (RedisError, OSError):
        cached = None
    if cached is not None:
        value = cached.decode() if isinstance(cached, bytes) else str(cached)
        return value or None
    accounts = getattr(request.app.state, "accounts", None)
    if accounts is None:
        return None
    try:
        user = await accounts.user_for_session(token)
    except Exception as exc:  # БД недоступна — рахуємо за IP, а не відмовляємо
        log.warning("rate_limit.account_lookup_failed", error=type(exc).__name__)
        return None
    user_id = str(user.id) if user is not None else ""
    with contextlib.suppress(RedisError, OSError):
        await redis.set(cache_key, user_id, ex=IDENTITY_TTL_S)
    return user_id or None


def limit_for(bucket: Bucket, settings: Settings) -> int:
    return {
        "search": settings.rate_limit_search_per_hour,
        "heavy": settings.rate_limit_heavy_per_hour,
        "check": settings.rate_limit_check_per_hour,
        "lookup": settings.rate_limit_lookup_per_hour,
        "ai": settings.rate_limit_ai_per_hour,
        "auth": settings.rate_limit_auth_per_hour,
        "clicks": settings.rate_limit_clicks_per_hour,
        "events": settings.rate_limit_events_per_hour,
    }[bucket]


async def _who(request: Request, bucket: Bucket) -> tuple[str, int]:
    """Ключ клієнта й множник ліміту: акаунт (для дорогих кошиків) або IP."""
    settings: Settings = request.app.state.settings
    if bucket in ACCOUNT_BUCKETS:
        user = await account_id(request, request.app.state.redis)
        if user is not None:
            return f"u:{user}", settings.rate_limit_account_multiplier
    return client_id(request, settings), 1


def rate_limit(bucket: Bucket) -> Callable[[Request], Awaitable[None]]:
    """Залежність FastAPI: понад ліміт — 429 з Retry-After."""

    async def dependency(request: Request) -> None:
        settings: Settings = request.app.state.settings
        redis: Redis = request.app.state.redis
        now = int(time.time())
        window = now // WINDOW_S
        who, multiplier = await _who(request, bucket)
        key = f"rl:{bucket}:{who}:{window}"
        try:
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, WINDOW_S)
        except Exception as exc:
            log.warning("rate_limit.redis_failed", bucket=bucket, error=type(exc).__name__)
            return
        if count > limit_for(bucket, settings) * multiplier:
            retry_after = (window + 1) * WINDOW_S - now
            log.info("rate_limit.exceeded", bucket=bucket, account=who.startswith("u:"))
            raise HTTPException(
                status_code=429,
                detail="rate_limited",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency


async def concurrent_searches(request: Request) -> AsyncIterator[None]:
    """Залежність FastAPI: не більше `max_concurrent_searches` пошуків одного клієнта разом.

    Пошук триває до 30–90 с; без цього один клієнт міг би запустити десятки паралельно, а
    ліміт за годину рахує лише старти. Понад ліміт — 429 (`Retry-After: 5`). Без
    INTERNAL_API_KEY відвідувачів не розрізнити — для анонімних не застосовуємо."""
    settings: Settings = request.app.state.settings
    redis: Redis = request.app.state.redis
    who, _ = await _who(request, "search")
    if settings.internal_api_key is None and not who.startswith("u:"):
        # Без спільного ключа всі відвідувачі — один IP сервера Vercel: ліміт «на клієнта»
        # обмежив би весь сайт. Пропускаємо (ліміти за годину й бюджет API діють).
        yield
        return
    key = f"cc:{who}"
    try:
        running = await redis.incr(key)
        await redis.expire(key, CONCURRENCY_TTL_S)
    except Exception as exc:
        log.warning("rate_limit.redis_failed", bucket="concurrent", error=type(exc).__name__)
        yield
        return
    try:
        if running > settings.max_concurrent_searches:
            log.info("rate_limit.concurrent", account=who.startswith("u:"))
            raise HTTPException(
                status_code=429, detail="rate_limited", headers={"Retry-After": "5"}
            )
        yield
    finally:
        try:
            await redis.decr(key)
        except Exception as exc:
            log.warning("rate_limit.redis_failed", bucket="concurrent", error=type(exc).__name__)
