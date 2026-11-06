"""ШІ-функції для API: розбір запиту і пояснення результатів з кешем, лімітом і обліком.

Модель недоступна чи вимкнена — пошук звичайною формою працює як раніше; ШІ лише додає.
"""

import hashlib
import json
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TypeVar

import structlog
from pydantic import BaseModel
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.ai.assistant import ChatContext, ChatReply, ChatTurn, TravelAssistant
from tickets_api.ai.explainer import ExplainResult, FlightExplainer
from tickets_api.ai.parser import ParseContext, ParseResult, QueryParser, Turn
from tickets_api.domain.flights import DEFAULT_CURRENCY, FlightQuery
from tickets_api.llm.metered import MeteredLLM, RecordUsage
from tickets_api.llm.pricing import Pricing
from tickets_api.llm.types import LLMClient
from tickets_api.repositories.price_history import PriceStats
from tickets_api.services.flight_search import FlightSearchService

log = structlog.get_logger(__name__)

CACHE_PREFIX = "ai:v1"
MAX_CALENDAR_MONTHS = 2
"""Найдешевший день шукаємо в календарі не далі двох місяців діапазону."""

PriceStatsLookup = Callable[[FlightQuery, Decimal], Awaitable[PriceStats | None]]
Clock = Callable[[], datetime]
M = TypeVar("M", bound=BaseModel)


class AIService:
    def __init__(
        self,
        client: LLMClient,
        *,
        parser: QueryParser,
        explainer: FlightExplainer,
        search: FlightSearchService,
        pricing: Pricing,
        max_calls: int,
        assistant: TravelAssistant | None = None,
        chat_max_calls: int = 6,
        redis: Redis,
        cache_ttl_s: int,
        record_usage: RecordUsage | None = None,
        price_stats: PriceStatsLookup | None = None,
        cache_namespace: str = "",
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self._parser = parser
        self._explainer = explainer
        self._assistant = assistant
        self._chat_max_calls = chat_max_calls
        self._search = search
        self._pricing = pricing
        self._max_calls = max_calls
        self._redis = redis
        self._cache_ttl_s = cache_ttl_s
        self._record_usage = record_usage
        self._price_stats = price_stats
        # Провайдер у ключі кешу (модель і промпт — у version парсера/пояснювача).
        self._namespace = cache_namespace
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def provider(self) -> str:
        return self._client.name

    async def parse(
        self, message: str, context: ParseContext, history: Sequence[Turn] = ()
    ) -> ParseResult:
        key = self._key(
            "parse",
            self._parser.version,
            message.strip(),
            context.model_dump_json(),
            json.dumps([turn.model_dump() for turn in history], ensure_ascii=False),
        )
        if (cached := await self._read(key, ParseResult)) is not None:
            return cached
        result = await self._parser.parse(message, context, self._metered("parse"), history)
        if result.status != "unavailable":  # збій моделі не кешуємо
            await self._write(key, result)
        return result

    async def explain(self, query: FlightQuery) -> ExplainResult:
        # Пошук іде з кешу провайдерів (сторінка результатів щойно зробила той самий).
        result = await self._search.search(query)
        picks = {p.offer_key for p in result.scoring.picks}
        offers = [o for o in result.offers if f"{o.source}:{o.id}" in picks]
        if not offers:
            return ExplainResult(status="no_options")
        fingerprint = [(o.source, o.id, str(o.price), o.collected_at.isoformat()) for o in offers]
        key = self._key(
            "explain", self._explainer.version, query.model_dump_json(), json.dumps(fingerprint)
        )
        if (cached := await self._read(key, ExplainResult)) is not None:
            return cached
        stats = await self._stats(query, min(o.price for o in result.offers))
        explained = await self._explainer.explain(
            query, result, self._metered("explain"), now=self._clock(), price_stats=stats
        )
        if explained.status in ("ok", "rejected"):
            await self._write(key, explained)
        return explained

    async def chat(self, turns: Sequence[ChatTurn], context: ChatContext) -> ChatReply:
        """Репліка розмови. Без кешу: кожна розмова своя (пошуки всередині — з кешу)."""
        if self._assistant is None:
            return ChatReply(status="unavailable")
        llm = self._metered("chat", self._chat_max_calls)
        return await self._assistant.reply(turns, context, llm)

    async def cheapest_day(
        self, origin: str, destination: str, start: date, end: date
    ) -> date | None:
        """Найдешевший день у діапазоні за календарем цін (кешовані ціни, без живих запитів)."""
        months: list[date] = []
        cursor = start.replace(day=1)
        while cursor <= end and len(months) < MAX_CALENDAR_MONTHS:
            months.append(cursor)
            cursor = date(cursor.year + cursor.month // 12, cursor.month % 12 + 1, 1)
        best: tuple[Decimal, date] | None = None
        for month in months:
            calendar = await self._search.calendar(origin, destination, month, DEFAULT_CURRENCY)
            for day in calendar.days:
                if start <= day.date <= end and (best is None or (day.price, day.date) < best):
                    best = (day.price, day.date)
        return best[1] if best else None

    # --- внутрішнє -----------------------------------------------------------------

    def _metered(self, purpose: str, max_calls: int | None = None) -> MeteredLLM:
        return MeteredLLM(
            self._client,
            purpose=purpose,
            pricing=self._pricing,
            max_calls=max_calls or self._max_calls,
            record=self._record_usage,
        )

    async def _stats(self, query: FlightQuery, best_price: Decimal) -> PriceStats | None:
        if self._price_stats is None:
            return None
        try:
            return await self._price_stats(query, best_price)
        except Exception as exc:  # статистика — контекст, а не умова пояснення
            log.warning("ai.price_stats_failed", error=type(exc).__name__)
            return None

    def _key(self, kind: str, *parts: str) -> str:
        digest = hashlib.sha256("\x1f".join((self._namespace, *parts)).encode()).hexdigest()
        return f"{CACHE_PREFIX}:{kind}:{digest[:32]}"

    async def _read(self, key: str, model: type[M]) -> M | None:
        try:
            raw = await self._redis.get(key)
        except RedisError as exc:
            log.warning("ai.cache_read_failed", error=type(exc).__name__)
            return None
        return model.model_validate_json(raw) if raw else None

    async def _write(self, key: str, value: BaseModel) -> None:
        try:
            await self._redis.set(key, value.model_dump_json(), ex=self._cache_ttl_s)
        except RedisError as exc:
            log.warning("ai.cache_write_failed", error=type(exc).__name__)
