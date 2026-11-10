"""Кеш відповідей провайдера в Redis з TTL — щоб не вичерпувати ліміти API.

Обгортка над будь-яким FlightProvider. Якщо Redis недоступний, просто ходимо до
провайдера напряму: кеш — оптимізація, а не залежність пошуку.

Однакові запити не дублюються (модуль 17.2, ADR 0034): у межах процесу — один спільний
виклик (`_shared`), між процесами (кілька воркерів API, воркер сповіщень) — замок у Redis:
хто взяв, той іде до джерела, інші чекають на його відповідь у кеші.

Ключ (17.1) — усе, що змінює відповідь ДЖЕРЕЛА: маршрут, дати (й гнучкість), пасажири, клас,
валюта, сусідні аеропорти, «лише прямі». Не входять профіль, фільтри, багаж і уподобання:
до джерела вони не йдуть (багаж SerpApi ціну не змінює, ADR 0014), тож лише дробили б кеш.
"""

import asyncio
import hashlib
import secrets
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any, cast

import structlog
from pydantic import TypeAdapter
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.domain.flights import CalendarDay, FlightQuery, Offer
from tickets_api.domain.sellers import SellerOffer
from tickets_api.domain.stay_rates import StayRate
from tickets_api.domain.stays import Stay, StayQuery, StayReview
from tickets_api.providers.base import (
    FlightProvider,
    ProviderUnsupportedError,
    SellerSource,
    StayProvider,
    StayRateSource,
    is_live,
)

log = structlog.get_logger(__name__)

_OFFERS = TypeAdapter(list[Offer])
_DAYS = TypeAdapter(list[CalendarDay])
_SELLERS = TypeAdapter(list[SellerOffer])
_STAYS = TypeAdapter(list[Stay])
_RATES = TypeAdapter(list[StayRate])
KEY_PREFIX = "fp:v1"
LOCK_TTL_S = 60
"""Замок живе не довше за найдовший пошук: впав процес — замок звільниться сам."""
LOCK_WAIT_S = 25.0
LOCK_POLL_S = 0.25
CACHE_EXCLUDED = {"profile", "filters", "baggage", "preferences"}
STAY_CACHE_EXCLUDED = {"profile", "filters", "preferences"}
"""Житло: фільтри й уподобання застосовує сервіс після джерела — у ключ не входять."""


def search_cache_payload(query: FlightQuery) -> str:
    """Те, від чого залежить відповідь джерела на пошук (див. docstring модуля)."""
    return query.model_dump_json(exclude=CACHE_EXCLUDED)


class RedisCache:
    """Спільна механіка кешу джерела: TTL, один виклик на однакові запити, замок між процесами."""

    def __init__(
        self,
        name: str,
        redis: Redis,
        ttl_s: int,
        *,
        lock_wait_s: float = LOCK_WAIT_S,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._redis = redis
        self._ttl_s = ttl_s
        self._lock_wait_s = lock_wait_s
        self._sleep = sleep
        self._inflight: dict[str, asyncio.Future[Any]] = {}
        self.name = name

    async def _cached[T](
        self, key: str, adapter: TypeAdapter[T], load: Callable[[], Awaitable[T]]
    ) -> T:
        cached = await self._read(key)
        if cached is not None:
            return adapter.validate_json(cached)
        return await self._shared(key, lambda: self._fetch(key, adapter, load))

    async def _shared[T](self, key: str, produce: Callable[[], Awaitable[T]]) -> T:
        """Однакові одночасні запити в процесі — один виклик. Скасування одного очікувача
        (тайм-аут його пошуку) не скасовує виклик для інших."""
        running = self._inflight.get(key)
        if running is None:
            running = asyncio.ensure_future(produce())
            self._inflight[key] = running
            running.add_done_callback(lambda done: self._finished(key, done))
        result: T = await asyncio.shield(running)
        return result

    def _finished(self, key: str, done: asyncio.Future[Any]) -> None:
        if self._inflight.get(key) is done:
            del self._inflight[key]
        if not done.cancelled():
            done.exception()  # позначити як отриману — без «exception was never retrieved»

    async def _fetch[T](
        self, key: str, adapter: TypeAdapter[T], load: Callable[[], Awaitable[T]]
    ) -> T:
        lock = await self._lock(key)
        if lock is None:
            # Цей самий запит уже виконує інший процес — чекаємо на його відповідь у кеші.
            waited = await self._wait_for_cache(key)
            if waited is not None:
                return adapter.validate_json(waited)
        try:
            value = await load()
            await self._write(key, adapter.dump_json(value))
            return value
        finally:
            if lock is not None:
                await self._unlock(key, lock)

    async def _lock(self, key: str) -> str | None:
        """Токен замка; None — замок у іншого процесу. Redis недоступний — ідемо без замка."""
        token = secrets.token_hex(8)
        try:
            taken = await self._redis.set(f"{key}:lock", token, nx=True, ex=LOCK_TTL_S)
        except RedisError as exc:
            log.warning("provider_cache.lock_failed", provider=self.name, error=type(exc).__name__)
            return token
        return token if taken else None

    async def _unlock(self, key: str, token: str) -> None:
        try:
            held = await self._redis.get(f"{key}:lock")
            if held is not None and held.decode() == token:
                await self._redis.delete(f"{key}:lock")
        except RedisError:
            pass  # замок сам зникне через LOCK_TTL_S

    async def _wait_for_cache(self, key: str) -> bytes | None:
        """Чекаємо, поки власник замка покладе відповідь; він упав чи звільнив без відповіді
        (помилка джерела) — повертаємо None і йдемо самі."""
        waited = 0.0
        while waited < self._lock_wait_s:
            await self._sleep(LOCK_POLL_S)
            waited += LOCK_POLL_S
            cached = await self._read(key)
            if cached is not None:
                return cached
            try:
                if await self._redis.get(f"{key}:lock") is None:
                    return None
            except RedisError:
                return None
        return None

    def _key(self, kind: str, payload: str) -> str:
        digest = hashlib.sha256(payload.encode()).hexdigest()[:32]
        return f"{KEY_PREFIX}:{self.name}:{kind}:{digest}"

    async def _read(self, key: str) -> bytes | None:
        try:
            value: bytes | None = await self._redis.get(key)
        except RedisError as exc:
            log.warning("provider_cache.read_failed", provider=self.name, error=type(exc).__name__)
            return None
        return value

    async def _write(self, key: str, value: bytes) -> None:
        try:
            await self._redis.set(key, value, ex=self._ttl_s)
        except RedisError as exc:
            log.warning("provider_cache.write_failed", provider=self.name, error=type(exc).__name__)


class CachedFlightProvider(RedisCache):
    def __init__(
        self,
        inner: FlightProvider,
        redis: Redis,
        ttl_s: int,
        *,
        lock_wait_s: float = LOCK_WAIT_S,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        super().__init__(inner.name, redis, ttl_s, lock_wait_s=lock_wait_s, sleep=sleep)
        self._inner = inner
        self.timeout_s: float | None = getattr(inner, "timeout_s", None)
        self.live: bool = is_live(inner)

    async def search(self, query: FlightQuery) -> list[Offer]:
        key = self._key("search", search_cache_payload(query))
        return await self._cached(key, _OFFERS, lambda: self._inner.search(query))

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        raw_key = f"{origin}|{destination}|{month:%Y-%m}|{currency}".upper()
        return await self._cached(
            self._key("calendar", raw_key),
            _DAYS,
            lambda: self._inner.calendar(origin, destination, month, currency),
        )

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Продавці теж кешуються (той самий TTL): повторне відкриття картки не витрачає квоту.
        Ціна продавця — за склад і клас запиту, тож вони теж у ключі."""
        inner = self._inner
        if not isinstance(inner, SellerSource):
            raise ProviderUnsupportedError(self.name, "sellers")
        raw_key = f"{booking_ref}|{query.currency}|{query.passengers.code}|{query.cabin}"
        return await self._cached(
            self._key("sellers", raw_key), _SELLERS, lambda: inner.sellers(query, booking_ref)
        )


class CachedStayProvider(RedisCache):
    """Житло за тим самим кешем (ADR 0044): платне джерело не питаємо вдруге про той самий пошук,
    а сторінка об'єкта й тарифи беруть його з кешу пошуку. Відгуки — без кешу (їх дає лише mock)."""

    def __init__(self, inner: StayProvider, redis: Redis, ttl_s: int) -> None:
        super().__init__(inner.name, redis, ttl_s)
        self._inner = inner
        self.timeout_s: float | None = getattr(inner, "timeout_s", None)

    async def search(self, query: StayQuery) -> list[Stay]:
        payload = query.model_dump_json(exclude=STAY_CACHE_EXCLUDED)
        return await self._cached(
            self._key("stay-search", payload), _STAYS, lambda: self._inner.search(query)
        )

    async def reviews(self, stay_id: str, *, limit: int = 30) -> list[StayReview]:
        return await self._inner.reviews(stay_id, limit=limit)

    async def rates(self, query: StayQuery, stay_id: str) -> list[StayRate]:
        inner = self._inner
        if not hasattr(inner, "rates"):
            raise ProviderUnsupportedError(self.name, "rates")
        source = cast(StayRateSource, inner)
        payload = f"{stay_id}|{query.model_dump_json(exclude=STAY_CACHE_EXCLUDED)}"
        return await self._cached(
            self._key("stay-rates", payload), _RATES, lambda: source.rates(query, stay_id)
        )
