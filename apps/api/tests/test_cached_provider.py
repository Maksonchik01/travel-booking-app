from datetime import UTC, date, datetime
from typing import Any, cast

from flight_fakes import FakeRedis, StubProvider, offers_for
from redis.asyncio import Redis
from tickets_api.domain.flights import FlightQuery, OfferFilters
from tickets_api.providers.cached import CachedFlightProvider

QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))


def cached(inner: StubProvider, redis: FakeRedis) -> CachedFlightProvider:
    return CachedFlightProvider(cast(Any, inner), cast(Redis, redis), ttl_s=600)


async def test_second_call_is_served_from_cache_with_original_collected_at() -> None:
    inner = StubProvider("tp", offers=offers_for("tp", [100, 80]))
    redis = FakeRedis()
    provider = cached(inner, redis)

    first = await provider.search(QUERY)
    second = await provider.search(QUERY)

    assert inner.calls == 1
    assert second == first
    assert second[0].collected_at == datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    assert [ttl for key, ttl in redis.ttl.items() if key.startswith("fp:")] == [600]
    # Облік кешу (ADR 0058): промах, потім влучання.
    stats = next(v for k, v in redis.hashes.items() if k.startswith("api:stats:"))
    assert stats == {"cache:tp:miss": 1, "cache:tp:hit": 1}


async def test_different_queries_use_different_keys() -> None:
    inner = StubProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis())

    await provider.search(QUERY)
    await provider.search(QUERY.model_copy(update={"direct_only": True}))

    assert inner.calls == 2


async def test_broken_redis_falls_through_to_provider() -> None:
    inner = StubProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis(broken=True))

    assert len(await provider.search(QUERY)) == 1
    assert len(await provider.search(QUERY)) == 1
    assert inner.calls == 2


async def test_calendar_is_cached() -> None:
    inner = StubProvider("tp")
    provider = cached(inner, FakeRedis())

    await provider.calendar("WAW", "LIS", date(2026, 11, 1), "EUR")
    await provider.calendar("waw", "lis", date(2026, 11, 20), "eur")

    assert inner.calls == 1


async def test_profile_does_not_split_cache() -> None:
    inner = StubProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis())

    await provider.search(QUERY)
    await provider.search(QUERY.model_copy(update={"profile": "time_is_money"}))

    assert inner.calls == 1


async def test_filters_do_not_split_cache() -> None:
    inner = StubProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis())

    await provider.search(QUERY)
    await provider.search(QUERY.model_copy(update={"filters": OfferFilters(max_stops=0)}))

    assert inner.calls == 1
