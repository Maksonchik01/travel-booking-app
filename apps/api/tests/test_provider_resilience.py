"""Модуль 17.1–17.3: ключ кешу, шлюз запитів (ліміт, повтори), однакові запити — один виклик,
свіжість ціни. Реальна мережа не потрібна: httpx.MockTransport і двійники."""

import asyncio
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast

import httpx
import pytest
from flight_fakes import FakeRedis, StubProvider, offers_for
from redis.asyncio import Redis
from tickets_api.domain.flights import (
    FlightPreferences,
    FlightQuery,
    OfferFilters,
    Passengers,
)
from tickets_api.domain.freshness import FreshnessRules, price_freshness
from tickets_api.providers.base import ProviderError
from tickets_api.providers.cached import CachedFlightProvider, search_cache_payload
from tickets_api.providers.gate import ProviderGate, RetryPolicy

QUERY = FlightQuery(
    origin="WAW", destination="LIS", departure_date=date(2026, 12, 5), return_date=date(2026, 12, 9)
)
NOW = datetime(2026, 11, 9, 12, tzinfo=UTC)

# --- 17.1: ключ кешу -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"origin": "KRK"},
        {"destination": "OPO"},
        {"departure_date": date(2026, 12, 6)},
        {"return_date": date(2026, 12, 10)},
        {"flex_days": 2},
        {"passengers": Passengers(adults=2)},
        {"passengers": Passengers(adults=1, children=1)},
        {"cabin": "business"},
        {"currency": "PLN"},
        {"direct_only": True},
        {"origin_radius_km": 150},
    ],
)
def test_everything_that_changes_the_source_answer_is_in_the_key(change: dict[str, Any]) -> None:
    assert search_cache_payload(QUERY) != search_cache_payload(QUERY.model_copy(update=change))


@pytest.mark.parametrize(
    "change",
    [
        {"profile": "budget"},
        {"filters": OfferFilters(max_stops=0)},
        {"baggage": "checked"},
        {"preferences": FlightPreferences(airlines=["LO"])},
    ],
)
def test_what_only_shapes_the_results_does_not_split_the_cache(change: dict[str, Any]) -> None:
    assert search_cache_payload(QUERY) == search_cache_payload(QUERY.model_copy(update=change))


# --- 17.2: шлюз --------------------------------------------------------------------------------


class Script:
    """Відповіді по черзі: число — HTTP-код, виняток — підняти."""

    def __init__(self, *steps: int | Exception) -> None:
        self.steps = list(steps)
        self.calls = 0

    async def __call__(self) -> httpx.Response:
        self.calls += 1
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return httpx.Response(step)


def gate(retry: RetryPolicy, sleeps: list[float], concurrency: int = 4) -> ProviderGate:
    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    return ProviderGate(
        "t", max_concurrency=concurrency, retry=retry, sleep=sleep, jitter=lambda: 1.0
    )


async def test_transient_errors_are_retried_with_growing_delay() -> None:
    sleeps: list[float] = []
    script = Script(503, httpx.ConnectError("down"), 200)

    response = await gate(RetryPolicy(attempts=3, base_delay_s=0.5), sleeps).send(script)

    assert response.status_code == 200
    assert script.calls == 3
    assert sleeps == [0.5, 1.0]  # 0,5 · 2^(n−1), jitter=1 → без зменшення


@pytest.mark.parametrize("status", [429, 400, 401, 404])
async def test_quota_and_client_errors_are_not_retried(status: int) -> None:
    script = Script(status, 200)
    response = await gate(RetryPolicy(attempts=3), []).send(script)
    assert response.status_code == status
    assert script.calls == 1


async def test_timeout_is_not_retried_when_policy_says_so() -> None:
    script = Script(httpx.ReadTimeout("slow"), 200)
    with pytest.raises(httpx.ReadTimeout):
        await gate(RetryPolicy(attempts=2, retry_timeouts=False), []).send(script)
    assert script.calls == 1


async def test_last_failure_is_returned_as_is() -> None:
    script = Script(502, 502)
    response = await gate(RetryPolicy(attempts=2), []).send(script)
    assert response.status_code == 502
    assert script.calls == 2


async def test_concurrency_is_limited() -> None:
    active = peak = 0

    async def call() -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200)

    g = gate(RetryPolicy(attempts=1), [], concurrency=2)
    await asyncio.gather(*(g.send(call) for _ in range(6)))
    assert peak == 2


def test_delay_is_capped_and_jittered() -> None:
    policy = RetryPolicy(base_delay_s=1, max_delay_s=3)
    assert policy.delay(5, jitter=1.0) == 3
    assert policy.delay(1, jitter=0.0) == 0.5


# --- 17.2: однакові запити — один виклик -----------------------------------------------------


class SlowProvider(StubProvider):
    async def search(self, query: FlightQuery) -> list[Any]:
        await asyncio.sleep(0.02)
        return await super().search(query)


def cached(inner: StubProvider, redis: FakeRedis, **kwargs: Any) -> CachedFlightProvider:
    return CachedFlightProvider(cast(Any, inner), cast(Redis, redis), ttl_s=600, **kwargs)


async def test_identical_concurrent_searches_share_one_source_call() -> None:
    inner = SlowProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis())

    results = await asyncio.gather(*(provider.search(QUERY) for _ in range(5)))

    assert inner.calls == 1
    assert all(r == results[0] for r in results)


async def test_cancelled_waiter_does_not_cancel_the_shared_call() -> None:
    inner = SlowProvider("tp", offers=offers_for("tp", [100]))
    provider = cached(inner, FakeRedis())

    impatient = asyncio.ensure_future(asyncio.wait_for(provider.search(QUERY), timeout=0.001))
    patient = asyncio.ensure_future(provider.search(QUERY))
    with pytest.raises(TimeoutError):
        await impatient
    assert len(await patient) == 1
    assert inner.calls == 1


async def test_other_process_holding_the_lock_is_awaited_via_cache() -> None:
    redis = FakeRedis()
    first = cached(SlowProvider("tp", offers=offers_for("tp", [100])), redis)
    second_inner = StubProvider("tp", offers=offers_for("tp", [999]))
    # Інший «процес» — окремий екземпляр зі своїм in-process станом, але тим самим Redis.
    second = cached(second_inner, redis)

    a, b = await asyncio.gather(first.search(QUERY), second.search(QUERY))

    assert second_inner.calls == 0
    assert a == b


async def test_failed_lock_holder_lets_waiters_go_to_the_source() -> None:
    redis = FakeRedis()
    provider = cached(StubProvider("tp", offers=offers_for("tp", [100])), redis)
    # Чужий замок без відповіді в кеші, що потім зникає: чекаємо, а тоді йдемо самі.
    payload_key = provider._key("search", search_cache_payload(QUERY))
    await redis.set(f"{payload_key}:lock", "other", nx=True, ex=60)

    async def release_later() -> None:
        await asyncio.sleep(0.05)
        await redis.delete(f"{payload_key}:lock")

    releaser = asyncio.ensure_future(release_later())
    offers = await provider.search(QUERY)
    await releaser
    assert len(offers) == 1


async def test_paid_source_does_not_pay_twice_while_another_process_holds_the_lock() -> None:
    """ADR 0058: не дочекались чужої відповіді — «зайнято», а не другий оплачений запит."""
    redis = FakeRedis()
    inner = StubProvider("serpapi", offers=offers_for("serpapi", [100]))  # живе = платне
    provider = cached(inner, redis, lock_wait_s=0.05)
    payload_key = provider._key("search", search_cache_payload(QUERY))
    await redis.set(f"{payload_key}:lock", "other", nx=True, ex=60)

    with pytest.raises(ProviderError, match="busy"):
        await provider.search(QUERY)
    assert inner.calls == 0

    # Безкоштовне кешоване джерело — йдемо самі.
    free = StubProvider("tp", offers=offers_for("tp", [100]), live=False)
    free_provider = cached(free, redis, lock_wait_s=0.05)
    free_key = free_provider._key("search", search_cache_payload(QUERY))
    await redis.set(f"{free_key}:lock", "other", nx=True, ex=60)
    assert len(await free_provider.search(QUERY)) == 1
    assert free.calls == 1


# --- 17.3: свіжість ----------------------------------------------------------------------------

RULES = FreshnessRules(live_fresh_min=30, cached_stale_days=3)


@pytest.mark.parametrize(
    ("live", "collected", "found_at", "found_on", "expected"),
    [
        (True, timedelta(minutes=5), None, None, "live"),
        (True, timedelta(minutes=31), None, None, "needs_recheck"),
        (False, timedelta(0), timedelta(days=1), None, "cached"),
        (False, timedelta(0), None, date(2026, 11, 8), "cached"),
        (False, timedelta(0), None, date(2026, 11, 1), "needs_recheck"),
        (False, timedelta(0), None, None, "approximate"),
    ],
)
def test_price_freshness(
    live: bool,
    collected: timedelta,
    found_at: timedelta | None,
    found_on: date | None,
    expected: str,
) -> None:
    assert (
        price_freshness(
            live=live,
            collected_at=NOW - collected,
            found_at=NOW - found_at if found_at is not None else None,
            found_on=found_on,
            now=NOW,
            rules=RULES,
        )
        == expected
    )


async def test_search_result_marks_each_offer_freshness() -> None:
    from tickets_api.scoring.config import default_scoring_config
    from tickets_api.services.flight_search import FlightSearchService

    live = offers_for("live", [100])[0].model_copy(
        update={"price_status": "live", "collected_at": NOW - timedelta(minutes=45)}
    )
    cached_offer = offers_for("tp", [90])[0].model_copy(update={"found_on": date(2026, 11, 8)})
    service = FlightSearchService(
        [StubProvider("t", offers=[live, cached_offer])],
        timeout_s=1,
        scoring_config=default_scoring_config(),
        clock=lambda: NOW,
    )

    result = await service.search(QUERY.model_copy(update={"return_date": None}))

    assert result.freshness == {"live:live-0": "needs_recheck", "tp:tp-0": "cached"}
