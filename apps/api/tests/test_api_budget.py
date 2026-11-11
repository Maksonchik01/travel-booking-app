"""Бюджет і облік платних API (V3, ADR 0055).

Атомарність і одночасні запити — на справжньому Redis (маркер integration, як у CI); HTTP
джерел — respx на записаних відповідях, у мережу не ходимо. Кожен тест має власну «дату»
(випадковий рік), тож лічильники різних тестів і прогонів не змішуються.
"""

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from redis.asyncio import Redis
from structlog.testing import capture_logs
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.base import ProviderError
from tickets_api.providers.budget import (
    AccountBudget,
    ApiMeter,
    ProviderBudgetError,
    optional_spend,
)
from tickets_api.providers.serpapi import SEARCH_PATH, SerpApiFlightProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.services.ops import api_spend

FIXTURES = Path(__file__).parent / "fixtures" / "serpapi"
BASE = "https://serp.test"
URL = f"{BASE}{SEARCH_PATH}"


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    url = os.environ.get("TEST_REDIS_URL")
    if not url:
        pytest.skip("TEST_REDIS_URL не заданий")
    client = Redis.from_url(url)
    yield client
    await client.aclose()


async def meter_for(redis: Redis, **budgets: AccountBudget) -> ApiMeter:
    """Лічильник на «свій» рік; ключі цього року з попередніх прогонів прибираємо."""
    now = datetime(2100 + uuid.uuid4().int % 7000, 5, 17, 10, 30, tzinfo=UTC)
    async for key in redis.scan_iter(match=f"api:*:{now:%Y}-*"):
        await redis.delete(key)
    return ApiMeter(redis, budgets, optional_share=0.5, warn_share=0.8, clock=lambda: now)


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    body.pop("_meta", None)
    return body


def one_way() -> FlightQuery:
    return FlightQuery(origin="WAW", destination="BCN", departure_date=date(2026, 12, 13))


pytestmark = pytest.mark.integration


async def test_limits_hold_under_concurrent_requests(redis: Redis) -> None:
    meter = await meter_for(redis, serpapi=AccountBudget(daily=10, monthly=100))

    async def one() -> bool:
        try:
            ticket = await meter.reserve("serpapi", "flights")
        except ProviderBudgetError:
            return False
        await meter.settle(ticket, ok=True)
        return True

    results = await asyncio.gather(*(one() for _ in range(30)))

    assert sum(results) == 10  # перевірка й додавання — одна операція Redis
    assert await meter.usage("serpapi") == {"hour": 10, "day": 10, "month": 10}
    stats = await meter.stats(1)
    assert stats["serpapi:flights:ok"] == 10
    assert stats["serpapi:flights:blocked"] == 20


async def test_failed_request_returns_the_reservation(redis: Redis) -> None:
    meter = await meter_for(redis, scrapedo=AccountBudget(monthly=20, units_per_request=10))

    for _ in range(5):
        ticket = await meter.reserve("scrapedo", "hotels")
        await meter.settle(ticket, ok=False)  # тайм-аут, 5xx — джерело кредитів не списує

    assert (await meter.usage("scrapedo"))["month"] == 0
    stats = await meter.stats(1)
    assert stats["scrapedo:hotels:err"] == 5
    assert "scrapedo:hotels:units" not in stats


async def test_optional_operations_stop_before_essential(redis: Redis) -> None:
    meter = await meter_for(redis, serpapi=AccountBudget(daily=4))

    with optional_spend():
        await meter.reserve("serpapi", "sellers")
        await meter.reserve("serpapi", "sellers")
        with pytest.raises(ProviderBudgetError):
            await meter.reserve("serpapi", "sellers")  # 50 % ліміту — для необов'язкових
    await meter.reserve("serpapi", "flights")
    await meter.reserve("serpapi", "flights")
    with pytest.raises(ProviderBudgetError):
        await meter.reserve("serpapi", "flights")


async def test_budget_blocks_the_provider_without_an_http_call(redis: Redis) -> None:
    meter = await meter_for(redis, serpapi=AccountBudget(monthly=1))
    async with httpx.AsyncClient() as http:
        provider = SerpApiFlightProvider(
            http, "key", airports=default_airport_directory(), base_url=BASE, meter=meter
        )
        with respx.mock:
            route = respx.get(URL).mock(return_value=httpx.Response(200, json=recorded("oneway")))
            assert await provider.search(one_way())
            with pytest.raises(ProviderBudgetError):
                await provider.search(one_way())
            assert route.call_count == 1

            # 5xx — повтор шлюзу, але резерв повертається: квоту не витрачено.
            meter2 = await meter_for(redis, serpapi=AccountBudget(monthly=1))
            provider2 = SerpApiFlightProvider(
                http, "key", airports=default_airport_directory(), base_url=BASE, meter=meter2
            )
            respx.get(URL).mock(return_value=httpx.Response(503))
            with pytest.raises(ProviderError, match="HTTP 503"):
                await provider2.search(one_way())
            assert (await meter2.usage("serpapi"))["month"] == 0


async def test_spend_summary_and_cost_per_successful_search(redis: Redis) -> None:
    meter = await meter_for(
        redis,
        serpapi=AccountBudget(daily=10, unit_cost_usd=Decimal("0.025")),
        scrapedo=AccountBudget(units_per_request=10, unit_cost_usd=Decimal("0.0001")),
    )
    for account, operation in [("serpapi", "flights")] * 4 + [("scrapedo", "hotels")] * 2:
        await meter.settle(await meter.reserve(account, operation), ok=True)
    await meter.note_search("flights", ok=True)
    await meter.note_search("flights", ok=False)
    await meter.note_search("stays", ok=True)

    spend = await api_spend(meter, warn_share=0.8)

    assert spend.accounts["serpapi"].used["day"] == 4
    assert spend.accounts["serpapi"].cost_usd_today == Decimal("0.100")
    assert spend.accounts["scrapedo"].used["month"] == 20
    assert spend.operations_7d["serpapi:flights"].ok == 4
    assert spend.searches_7d["flights"] == {"ok": 1, "empty": 1}
    # (4 × 0,025 + 20 × 0,0001) / 2 успішних пошуки
    assert spend.cost_usd_7d == Decimal("0.1020")
    assert spend.cost_per_successful_search_usd_7d == Decimal("0.0510")
    assert spend.accounts["serpapi"].near_limit is False


async def test_warning_is_logged_once_per_period(redis: Redis) -> None:
    meter = await meter_for(redis, serpapi=AccountBudget(daily=5))
    with capture_logs() as logs:
        for _ in range(5):
            await meter.reserve("serpapi", "flights")

    warnings = [e for e in logs if e["event"] == "api_budget.warning"]
    assert [(w["period"], w["used"], w["limit"]) for w in warnings] == [("day", 4, 5)]
    assert (await api_spend(meter, warn_share=0.8)).accounts["serpapi"].near_limit is True


async def test_redis_down_lets_requests_through() -> None:
    down = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    meter = ApiMeter(down, {"serpapi": AccountBudget(monthly=0)})
    ticket = await meter.reserve("serpapi", "flights")  # захисна сітка, не причина відмови
    await meter.settle(ticket, ok=True)
    assert ticket.keys is None
    await down.aclose()
