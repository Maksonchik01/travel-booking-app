"""Ліміт викликів, облік токенів і вартості для одного запиту користувача."""

import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import LLMUsage
from tickets_api.llm.pricing import Pricing
from tickets_api.llm.types import ChatRequest, ChatResponse, LLMClient, LLMError, Usage

log = structlog.get_logger(__name__)

RecordUsage = Callable[[dict[str, Any]], Awaitable[None]]
Clock = Callable[[], datetime]


class LLMBudgetExceededError(LLMError):
    pass


class MeteredLLM:
    """Обгортка над клієнтом на ОДИН запит користувача (розбір чи пояснення).

    Не дає зробити більше `max_calls` викликів, рахує вартість і пише кожен виклик у
    лог і `llm_usage`. Текст запиту не логуємо — лише розміри й вартість.
    """

    def __init__(
        self,
        client: LLMClient,
        *,
        purpose: str,
        pricing: Pricing,
        max_calls: int,
        record: RecordUsage | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self.name = client.name
        self._purpose = purpose
        self._pricing = pricing
        self._max_calls = max_calls
        self._record = record
        self._clock = clock or (lambda: datetime.now(UTC))
        self.request_id = uuid.uuid4().hex
        self.calls = 0
        self.usage = Usage()
        self.cost_usd: Decimal | None = Decimal(0)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if self.calls >= self._max_calls:
            raise LLMBudgetExceededError(self._client.name, f"limit of {self._max_calls} calls")
        self.calls += 1
        started = time.monotonic()
        try:
            response = await self._client.chat(request)
        except LLMError as exc:
            await self._log(request.model, "error", Usage(), None, started, error=exc.message)
            raise
        cost = self._pricing.cost(request.model, response.usage, self._clock())
        self.usage = Usage(
            self.usage.input_cache_hit + response.usage.input_cache_hit,
            self.usage.input_cache_miss + response.usage.input_cache_miss,
            self.usage.output + response.usage.output,
        )
        self.cost_usd = None if cost is None or self.cost_usd is None else self.cost_usd + cost
        await self._log(request.model, "ok", response.usage, cost, started)
        return response

    async def _log(
        self,
        model: str,
        status: str,
        usage: Usage,
        cost: Decimal | None,
        started: float,
        error: str | None = None,
    ) -> None:
        latency_ms = int((time.monotonic() - started) * 1000)
        log.info(
            "llm.call",
            request_id=self.request_id,
            purpose=self._purpose,
            model=model,
            status=status,
            error=error,
            input_cache_hit=usage.input_cache_hit,
            input_cache_miss=usage.input_cache_miss,
            output=usage.output,
            cost_usd=str(cost) if cost is not None else None,
            latency_ms=latency_ms,
        )
        if self._record is not None:
            await self._record(
                {
                    "request_id": self.request_id,
                    "purpose": self._purpose,
                    "provider": self._client.name,
                    "model": model,
                    "status": status,
                    "input_cache_hit_tokens": usage.input_cache_hit,
                    "input_cache_miss_tokens": usage.input_cache_miss,
                    "output_tokens": usage.output,
                    "cost_usd": cost,
                    "latency_ms": latency_ms,
                }
            )


class LLMUsageRecorder:
    """Пише облік у власній сесії. Збій БД не ламає відповідь — лише лог."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def record(self, row: dict[str, Any]) -> None:
        try:
            async with self._sessionmaker() as session, session.begin():
                session.add(LLMUsage(**row))
        except Exception as exc:  # облік — побічний ефект, не причина 500
            log.warning("llm_usage.write_failed", error=type(exc).__name__)
