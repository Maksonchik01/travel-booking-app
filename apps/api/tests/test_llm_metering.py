import os
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from tickets_api.llm.metered import LLMBudgetExceededError, LLMSpendGuard, MeteredLLM
from tickets_api.llm.pricing import default_pricing
from tickets_api.llm.types import ChatRequest, ChatResponse, LLMError, Message, Usage

# Середа 2026-11-04: 07:00 UTC — пік, 12:00 UTC — ні.
PEAK = datetime(2026, 11, 4, 7, 0, tzinfo=UTC)
OFF_PEAK = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
SATURDAY_PEAK_HOUR = datetime(2026, 11, 7, 7, 0, tzinfo=UTC)
USER_TEXT = "Лісабон на тиждень, мій паспорт AA123456"
REQUEST = ChatRequest(model="deepseek-v4-pro", messages=(Message("user", USER_TEXT),))


class FakeClient:
    name = "fake"

    def __init__(self, usage: Usage | None = None, error: LLMError | None = None) -> None:
        self.usage = usage or Usage(input_cache_hit=1_000, input_cache_miss=2_000, output=500)
        self.error = error

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if self.error:
            raise self.error
        return ChatResponse(model=request.model, content="{}", usage=self.usage)


def test_cost_uses_cache_hits_and_peak_hours() -> None:
    pricing = default_pricing()
    usage = Usage(input_cache_hit=1_000_000, input_cache_miss=1_000_000, output=1_000_000)

    peak = pricing.cost("deepseek-v4-pro", usage, PEAK)
    assert peak == Decimal("0.044") + Decimal("1.32") + Decimal("3.96")
    assert pricing.cost("deepseek-v4-pro", usage, OFF_PEAK) == peak / 2
    assert pricing.cost("deepseek-v4-pro", usage, SATURDAY_PEAK_HOUR) == peak / 2
    assert pricing.cost("unknown-model", usage, PEAK) is None


async def test_metered_sums_usage_and_records_each_call() -> None:
    rows: list[dict[str, Any]] = []

    async def record(row: dict[str, Any]) -> None:
        rows.append(row)

    llm = MeteredLLM(
        FakeClient(),
        purpose="explain",
        pricing=default_pricing(),
        max_calls=2,
        record=record,
        clock=lambda: PEAK,
    )

    await llm.chat(REQUEST)
    await llm.chat(REQUEST)

    assert llm.usage == Usage(2_000, 4_000, 1_000)
    one = (1_000 * Decimal("0.044") + 2_000 * Decimal("1.32") + 500 * Decimal("3.96")) / 10**6
    assert llm.cost_usd == 2 * one.quantize(Decimal("0.000001"))
    assert [r["status"] for r in rows] == ["ok", "ok"]
    assert {r["request_id"] for r in rows} == {llm.request_id}
    assert USER_TEXT not in str(rows)  # текст запиту не пишемо

    with pytest.raises(LLMBudgetExceededError):
        await llm.chat(REQUEST)


async def test_metered_records_errors() -> None:
    rows: list[dict[str, Any]] = []

    async def record(row: dict[str, Any]) -> None:
        rows.append(row)

    llm = MeteredLLM(
        FakeClient(error=LLMError("fake", "timeout", retryable=True)),
        purpose="parse",
        pricing=default_pricing(),
        max_calls=3,
        record=record,
    )

    with pytest.raises(LLMError):
        await llm.chat(REQUEST)
    assert rows[0]["status"] == "error"
    assert rows[0]["cost_usd"] is None


def test_system_prompt_combines_rules_and_role() -> None:
    from tickets_api.llm.prompts import system_prompt

    prompt = system_prompt("Query-Parser")

    assert prompt.startswith("# ЗАГАЛЬНІ ПРАВИЛА")
    assert "lookup_airport" in prompt


@pytest.mark.integration
async def test_spend_guard_stops_ai_at_the_daily_budget() -> None:
    """Ліміт витрат на ШІ для всіх процесів (ADR 0056): Redis, як у продакшні."""
    url = os.environ.get("TEST_REDIS_URL")
    if not url:
        pytest.skip("TEST_REDIS_URL не заданий")
    redis = Redis.from_url(url)
    day = datetime(2100 + uuid.uuid4().int % 6000, 1, 1, 12, tzinfo=UTC)  # свій лічильник
    async for key in redis.scan_iter(match=f"llm:spend:*:{day:%Y}-*"):
        await redis.delete(key)
    guard = LLMSpendGuard(
        redis, daily_usd=Decimal("0.004"), monthly_usd=Decimal("1"), clock=lambda: day
    )
    llm = MeteredLLM(
        FakeClient(),
        purpose="chat",
        pricing=default_pricing(),
        max_calls=10,
        clock=lambda: PEAK,
        guard=guard,
    )
    await llm.chat(REQUEST)  # ≈ $0.0047 — останній виклик може трохи перевищити ліміт
    assert (await guard.spent_usd())[0] == llm.cost_usd

    with pytest.raises(LLMBudgetExceededError, match="day budget"):
        await llm.chat(REQUEST)
    assert llm.calls == 1  # моделі не викликали
    await redis.aclose()


async def test_spend_guard_lets_ai_work_without_redis() -> None:
    down = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    guard = LLMSpendGuard(down, daily_usd=Decimal("0"), monthly_usd=None)
    await guard.check()  # захисна сітка: без Redis не блокуємо
    await guard.add(Decimal("0.01"))
    await down.aclose()
