"""Технічні сповіщення власнику й керування лімітами (V3, етап 10, ADR 0062).

Redis — справжній (маркер integration), кожен тест — на «свій» рік; HTTP — respx.
"""

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx
from conftest import make_settings
from redis.asyncio import Redis
from tickets_api.llm.metered import LLMSpendGuard
from tickets_api.notifications.mail import MockMailer
from tickets_api.notifications.telegram import MockTelegram
from tickets_api.providers.budget import (
    OVERRIDES_KEY,
    AccountBudget,
    ApiMeter,
    ProviderBudgetError,
)
from tickets_api.services.ops_watch import OpsWatch

pytestmark = pytest.mark.integration
API = "https://api.test"


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    url = os.environ.get("TEST_REDIS_URL")
    if not url:
        pytest.skip("TEST_REDIS_URL не заданий")
    client = Redis.from_url(url)
    yield client
    await client.aclose()


async def env(redis: Redis, **settings: Any) -> tuple[OpsWatch, ApiMeter, MockTelegram, MockMailer]:
    now = datetime(2100 + uuid.uuid4().int % 7000, 3, 10, 12, tzinfo=UTC)
    async for key in redis.scan_iter(match=f"*{now:%Y}-*"):
        await redis.delete(key)
    for key in ("ops:api_failures", OVERRIDES_KEY):
        await redis.delete(key)
    async for key in redis.scan_iter(match="ops:alerted:*"):
        await redis.delete(key)
    meter = ApiMeter(redis, {"serpapi": AccountBudget(daily=10, monthly=100)}, clock=lambda: now)
    guard = LLMSpendGuard(
        redis, daily_usd=Decimal("1"), monthly_usd=Decimal("10"), clock=lambda: now
    )
    telegram, mailer = MockTelegram(), MockMailer()
    watch = OpsWatch(
        make_settings(
            ops_api_url=API,
            ops_telegram_chat_id=42,
            ops_alert_email="owner@example.com",
            llm_budget_daily_usd=Decimal("1"),
            llm_budget_monthly_usd=Decimal("10"),
            **settings,
        ),
        redis=redis,
        http=httpx.AsyncClient(),
        meter=meter,
        spend_guard=guard,
        telegram=telegram,
        mailer=mailer,
        clock=lambda: now,
    )
    return watch, meter, telegram, mailer


@respx.mock
async def test_healthy_service_sends_nothing(redis: Redis) -> None:
    respx.get(f"{API}/health/ready").mock(return_value=httpx.Response(200))
    watch, _, telegram, mailer = await env(redis)

    assert await watch.run() == []
    assert telegram.sent == []
    assert mailer.sent == []


@respx.mock
async def test_api_down_alerts_after_two_failures_once(redis: Redis) -> None:
    respx.get(f"{API}/health/ready").mock(return_value=httpx.Response(503))
    watch, _, telegram, mailer = await env(redis)

    assert await watch.run() == []  # один збій — може бути пробудження Render free
    second = await watch.run()
    third = await watch.run()

    assert [p.key for p in second] == ["api_down"]
    assert [p.key for p in third] == ["api_down"]
    assert len(telegram.sent) == 1  # повтор — не раніше, ніж за 6 год
    assert telegram.sent[0].chat_id == 42
    assert mailer.sent[0][0] == "owner@example.com"


@respx.mock
async def test_budget_errors_slowdown_llm_and_rate_limit_spike(redis: Redis) -> None:
    respx.get(f"{API}/health/ready").mock(return_value=httpx.Response(200))
    watch, meter, telegram, _ = await env(redis, ops_rate_limit_spike=5)
    for _ in range(9):  # 90 % добового ліміту SerpApi
        await meter.settle(await meter.reserve("serpapi", "flights"), ok=True)
    now = meter._clock()
    today = f"api:stats:{now:%Y-%m-%d}"
    week_ago = f"api:stats:{now - timedelta(days=3):%Y-%m-%d}"
    pipe = redis.pipeline()
    pipe.hset(today, mapping={"scrapedo:hotels:req": 20, "scrapedo:hotels:err": 15})
    pipe.hset(
        today, mapping={"travelpayouts:calendar:req": 20, "travelpayouts:calendar:ms": 200_000}
    )
    pipe.hset(
        week_ago, mapping={"travelpayouts:calendar:req": 50, "travelpayouts:calendar:ms": 50_000}
    )
    pipe.hset(today, mapping={"ratelimit:search:blocked": 7})
    await pipe.execute()
    await watch._guard.add(Decimal("0.9"))  # 90 % добового ліміту ШІ

    keys = {p.key for p in await watch.run()}

    assert keys == {
        "budget:serpapi:day",
        "provider_errors:scrapedo:hotels",
        "provider_slow:travelpayouts:calendar",
        "llm_budget:day",
        "rate_limit_spike",
    }
    texts = " ".join(m.text for m in telegram.sent)
    assert "9 з 10" in texts
    assert "15 помилок з 20" in texts


async def test_owner_changes_limits_without_redeploy(redis: Redis) -> None:
    _, meter, _, _ = await env(redis)
    await meter.set_limit("serpapi", "day", 1)
    await meter.settle(await meter.reserve("serpapi", "flights"), ok=True)
    with pytest.raises(ProviderBudgetError):
        await meter.reserve("serpapi", "flights")

    await meter.set_limit("serpapi", "day", None)  # без ліміту
    assert (await meter.effective("serpapi")).daily is None
    await meter.reserve("serpapi", "flights")

    await meter.reset_limit("serpapi", "day")  # назад до конфігу
    assert (await meter.effective("serpapi")).daily == 10
