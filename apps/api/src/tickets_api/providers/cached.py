"""Кеш відповідей провайдера в Redis з TTL — щоб не вичерпувати ліміти API.

Обгортка над будь-яким FlightProvider. Якщо Redis недоступний, просто ходимо до
провайдера напряму: кеш — оптимізація, а не залежність пошуку.
"""

import hashlib
from datetime import date

import structlog
from pydantic import TypeAdapter
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.domain.flights import CalendarDay, FlightQuery, Offer
from tickets_api.domain.sellers import SellerOffer
from tickets_api.providers.base import FlightProvider, ProviderUnsupportedError, SellerSource

log = structlog.get_logger(__name__)

_OFFERS = TypeAdapter(list[Offer])
_DAYS = TypeAdapter(list[CalendarDay])
_SELLERS = TypeAdapter(list[SellerOffer])
KEY_PREFIX = "fp:v1"


class CachedFlightProvider:
    def __init__(self, inner: FlightProvider, redis: Redis, ttl_s: int) -> None:
        self._inner = inner
        self._redis = redis
        self._ttl_s = ttl_s
        self.name = inner.name
        self.timeout_s: float | None = getattr(inner, "timeout_s", None)

    async def search(self, query: FlightQuery) -> list[Offer]:
        # Профіль і фільтри впливають лише на видачу — у ключі кешу вони б тільки дробили кеш.
        key = self._key("search", query.model_dump_json(exclude={"profile", "filters", "baggage"}))
        cached = await self._read(key)
        if cached is not None:
            return _OFFERS.validate_json(cached)
        offers = await self._inner.search(query)
        await self._write(key, _OFFERS.dump_json(offers))
        return offers

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        raw_key = f"{origin}|{destination}|{month:%Y-%m}|{currency}".upper()
        key = self._key("calendar", raw_key)
        cached = await self._read(key)
        if cached is not None:
            return _DAYS.validate_json(cached)
        days = await self._inner.calendar(origin, destination, month, currency)
        await self._write(key, _DAYS.dump_json(days))
        return days

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Продавці теж кешуються (той самий TTL): повторне відкриття картки не витрачає квоту."""
        if not isinstance(self._inner, SellerSource):
            raise ProviderUnsupportedError(self.name, "sellers")
        key = self._key("sellers", f"{booking_ref}|{query.currency}")
        cached = await self._read(key)
        if cached is not None:
            return _SELLERS.validate_json(cached)
        sellers = await self._inner.sellers(query, booking_ref)
        await self._write(key, _SELLERS.dump_json(sellers))
        return sellers

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
