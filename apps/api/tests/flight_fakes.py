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

    async def set(
        self, key: str, value: bytes | str | int, ex: int | None = None, nx: bool = False
    ) -> bool | None:
        if self.broken:
            raise RedisConnectionError("down")
        if nx and key in self.store:
            return None
        self.store[key] = value if isinstance(value, bytes) else str(value).encode()
        if ex is not None:
            self.ttl[key] = ex
        return True

    async def getdel(self, key: str) -> bytes | None:
        return self.store.pop(key, None)

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)
        self.ttl.pop(key, None)

    async def incr(self, key: str) -> int:
        value = int(self.store.get(key, b"0")) + 1
        self.store[key] = str(value).encode()
        return value

    async def expire(self, key: str, seconds: int) -> None:
        self.ttl[key] = seconds


class StubProvider:
    """Повертає задані дані або піднімає задану помилку; рахує виклики."""

    def __init__(
        self,
        name: str,
        offers: list[Offer] | None = None,
        days: list[CalendarDay] | None = None,
        error: BaseException | None = None,
        delay_s: float = 0,
        live: bool = True,
    ) -> None:
        self.name = name
        self.live = live
        self._offers = offers or []
        self._days = days or []
        self._error = error
        self._delay_s = delay_s
        self.calls = 0
        self.queries: list[FlightQuery] = []

    async def search(self, query: FlightQuery) -> list[Offer]:
        self.queries.append(query)
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
