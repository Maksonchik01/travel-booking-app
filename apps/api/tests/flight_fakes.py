"""Тестові двійники для провайдерів і Redis та фабрики даних."""

import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal

from redis.exceptions import ConnectionError as RedisConnectionError
from tickets_api.domain.flights import CalendarDay, FlightQuery, Leg, Offer


class FakeRedis:
    def __init__(self, *, broken: bool = False) -> None:
        self.store: dict[str, bytes] = {}
        self.ttl: dict[str, int] = {}
        self.broken = broken

    async def get(self, key: str) -> bytes | None:
        if self.broken:
            raise RedisConnectionError("down")
        return self.store.get(key)

    async def set(self, key: str, value: bytes | int, ex: int | None = None) -> None:
        if self.broken:
            raise RedisConnectionError("down")
        self.store[key] = value if isinstance(value, bytes) else str(value).encode()
        if ex is not None:
            self.ttl[key] = ex


class StubProvider:
    """Повертає задані дані або піднімає задану помилку; рахує виклики."""

    def __init__(
        self,
        name: str,
        offers: list[Offer] | None = None,
        days: list[CalendarDay] | None = None,
        error: BaseException | None = None,
        delay_s: float = 0,
    ) -> None:
        self.name = name
        self._offers = offers or []
        self._days = days or []
        self._error = error
        self._delay_s = delay_s
        self.calls = 0

    async def search(self, query: FlightQuery) -> list[Offer]:
        return await self._respond(self._offers)

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        return await self._respond(self._days)

    async def _respond[T](self, items: list[T]) -> list[T]:
        self.calls += 1
        if self._delay_s:
            await asyncio.sleep(self._delay_s)
        if self._error:
            raise self._error
        return items


COLLECTED_AT = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def offers_for(source: str, prices: list[int]) -> list[Offer]:
    return [
        Offer(
            id=f"{source}-{i}",
            source=source,
            price=Decimal(price),
            currency="EUR",
            outbound=Leg(
                origin="WAW",
                destination="LIS",
                departure_at=datetime(2026, 11, 10, 6, 0, tzinfo=UTC),
                duration_min=240,
                stops=0,
            ),
            airlines=["LO"],
            details_level="summary",
            collected_at=COLLECTED_AT,
        )
        for i, price in enumerate(prices)
    ]


def day(source: str, d: int, price: int, currency: str = "EUR") -> CalendarDay:
    return CalendarDay(
        date=date(2026, 11, d),
        price=Decimal(price),
        currency=currency,
        source=source,
        collected_at=COLLECTED_AT,
    )
