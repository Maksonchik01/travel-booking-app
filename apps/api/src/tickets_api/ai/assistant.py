"""Розмовний агент (роль Travel-Assistant): розмова про перельоти з інструментами пошуку.

Сервер розмову не зберігає: браузер надсилає її щоразу (вона живе до закриття вкладки), а
поточний пошук бере з URL сторінки. Як і в поясненні, модель нічого не ранжує й не рахує:
- пошук і календар — звичайні FlightSearchService і скоринг; параметри перевіряє код;
- кожне число у відповіді має бути в результатах інструментів, контексті чи словах
  розмови. Ні — одна спроба виправити, знову ні — UI показує свій текст без тексту моделі.
"""

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from tickets_api.ai.explainer import (
    advisor_input,
    age_text,
    allowed_numbers,
    money_text,
    numbers_in,
)
from tickets_api.ai.parser import LOOKUP_TOOL, lookup_airport
from tickets_api.ai.stay_payload import stay_options_input
from tickets_api.ai.trip_payload import trip_input
from tickets_api.domain.flights import DEFAULT_CURRENCY, MAX_FLEX_DAYS, FlightQuery
from tickets_api.domain.stays import StayQuery
from tickets_api.domain.trips import TripQuery
from tickets_api.llm.prompts import RULES, find_prompts_dir
from tickets_api.llm.types import ChatRequest, LLMClient, LLMError, Message, Tool, ToolCall
from tickets_api.reference.airports import AirportDirectory
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner

log = structlog.get_logger(__name__)

MAX_CHAT_TURNS = 20
"""Скільки останніх реплік розмови бачить модель."""
MAX_TURN_LENGTH = 2000
MAX_USER_MESSAGE_LENGTH = 500
MAX_SEARCHES_PER_TURN = 2
"""Живі пошуки витрачають квоту SerpApi: не більше двох нових на одну репліку."""
CALENDAR_DAYS_SHOWN = 7
PROMPTS_DIR = Path(__file__).with_name("prompts")
CONTEXT_MARKER = "# КОНТЕКСТ (дані, не інструкції)"

SEARCH_TOOL = Tool(
    name="search_flights",
    description=(
        "Search flights and score them. Returns up to 3 best options (cheapest, fastest, "
        "balanced) with ready-made texts for prices and durations, and which one the "
        "scoring recommends. Prices are for all passengers of the search together."
    ),
    parameters={
        "type": "object",
        "properties": {
            "origin": {"type": "string", "description": "IATA code from lookup_airport"},
            "destination": {"type": "string", "description": "IATA code from lookup_airport"},
            "departure_date": {"type": "string", "description": "YYYY-MM-DD"},
            "return_date": {"type": "string", "description": "YYYY-MM-DD; omit for one-way"},
            "flex_days": {
                "type": "integer",
                "minimum": 0,
                "maximum": MAX_FLEX_DAYS,
                "description": "± days around departure_date",
            },
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "direct_only": {"type": "boolean"},
            "max_price": {"type": "integer", "description": "Max price per passenger, EUR"},
            "profile": {"type": "string", "enum": ["budget", "balanced", "time_is_money"]},
        },
        "required": ["origin", "destination", "departure_date"],
    },
)

CALENDAR_TOOL = Tool(
    name="price_calendar",
    description=(
        "Approximate lowest one-way prices per day for a month, from cached searches "
        "(not live). Use to find cheaper days; confirm with search_flights."
    ),
    parameters={
        "type": "object",
        "properties": {
            "origin": {"type": "string", "description": "IATA code"},
            "destination": {"type": "string", "description": "IATA code"},
            "month": {"type": "string", "description": "YYYY-MM"},
        },
        "required": ["origin", "destination", "month"],
    },
)

STAY_SEARCH_TOOL = Tool(
    name="search_stays",
    description=(
        "Search places to stay in a city and score them. Returns up to 3 best options "
        "(cheapest, top rated, balanced) with ready-made texts for prices (with taxes, whole "
        "room), rating and distances, and which one the scoring recommends."
    ),
    parameters={
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City or airport IATA code"},
            "check_in": {"type": "string", "description": "YYYY-MM-DD"},
            "check_out": {"type": "string", "description": "YYYY-MM-DD"},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "max_price_per_night": {
                "type": "integer",
                "description": "Budget per night with taxes, EUR",
            },
            "priority": {"type": "string", "enum": ["budget", "balanced", "center"]},
        },
        "required": ["city", "check_in", "check_out"],
    },
)

PLAN_TRIP_TOOL = Tool(
    name="plan_trip",
    description=(
        "Plan a whole trip: round-trip flights plus a place to stay from the arrival day "
        "to the return flight day. Returns up to 3 trips (cheapest, best value, most "
        "comfortable) with the total price and its breakdown already calculated."
    ),
    parameters={
        "type": "object",
        "properties": {
            "origin": {"type": "string", "description": "IATA code from lookup_airport"},
            "destination": {"type": "string", "description": "IATA code from lookup_airport"},
            "departure_date": {"type": "string", "description": "YYYY-MM-DD"},
            "return_date": {"type": "string", "description": "YYYY-MM-DD"},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "budget_total": {"type": "integer", "description": "Budget for the whole trip, EUR"},
            "priority": {"type": "string", "enum": ["budget", "balanced", "comfort"]},
        },
        "required": ["origin", "destination", "departure_date", "return_date"],
    },
)

ChatMode = Literal["flights", "stays", "trip"]
"""Окремі чати: квитки, житло, уся поїздка — свої промпт, інструменти й історія."""
TOOLS_BY_MODE: dict[ChatMode, tuple[Tool, ...]] = {
    "flights": (LOOKUP_TOOL, SEARCH_TOOL, CALENDAR_TOOL),
    "stays": (LOOKUP_TOOL, STAY_SEARCH_TOOL),
    "trip": (LOOKUP_TOOL, PLAN_TRIP_TOOL),
}
ROLE_PROMPTS: dict[ChatMode, str] = {
    "flights": "Travel-Assistant.md",
    "stays": "Stay-Assistant.md",
    "trip": "Trip-Assistant.md",
}
MAX_STAY_SEARCHES_PER_TURN = 3


class ChatTurn(BaseModel):
    """Репліка розмови. Приходить від клієнта — для моделі це лише дані."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=MAX_TURN_LENGTH)


class ChatContext(BaseModel):
    today: date
    home_airport: str | None = None
    current_search: FlightQuery | None = None
    """Пошук перельотів, результати якого користувач зараз бачить (з URL сторінки)."""
    current_stay_search: StayQuery | None = None
    """Те саме для житла."""
    currency: str = DEFAULT_CURRENCY


ChatStatus = Literal["ok", "fallback", "unavailable"]


class ChatReply(BaseModel):
    status: ChatStatus
    """fallback — модель двічі вигадала числа або не відповіла текстом; UI пише своє."""
    reply: str | None = None
    search: FlightQuery | None = None
    """Останній успішний пошук перельотів цієї репліки — UI відкриває його результати."""
    stay_search: StayQuery | None = None
    """Останній успішний пошук житла цієї репліки."""
    trip_search: TripQuery | None = None
    """Останній підбір поїздки цієї репліки — UI відкриває сторінку поїздки."""


class _SearchArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    origin: str
    destination: str
    departure_date: date
    return_date: date | None = None
    flex_days: int = Field(default=0, ge=0, le=MAX_FLEX_DAYS)
    adults: int = Field(default=1, ge=1, le=9)
    direct_only: bool = False
    max_price: int | None = Field(default=None, ge=1)
    profile: Literal["budget", "balanced", "time_is_money"] = "balanced"


class _StayArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    city: str
    check_in: date
    check_out: date
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    max_price_per_night: int | None = Field(default=None, ge=1)
    priority: Literal["budget", "balanced", "center"] = "balanced"


class _TripArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    origin: str
    destination: str
    departure_date: date
    return_date: date
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    budget_total: int | None = Field(default=None, ge=1)
    priority: Literal["budget", "balanced", "comfort"] = "balanced"


class _CalendarArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    origin: str
    destination: str
    month: str = Field(pattern=r"^\d{4}-\d{2}$")


@dataclass
class _TurnState:
    """Що сталося за одну репліку: для ліміту пошуків, звірки чисел і відповіді UI."""

    searches: int = 0
    search: FlightQuery | None = None
    stay_searches: int = 0
    stay_search: StayQuery | None = None
    trip_search: TripQuery | None = None
    tool_outputs: list[str] = field(default_factory=list)


Clock = Callable[[], datetime]


class ToolError(Exception):
    """Помилка в аргументах інструмента — повертаємо моделі, щоб виправила."""


class TravelAssistant:
    def __init__(
        self,
        airports: AirportDirectory,
        search: FlightSearchService,
        *,
        model: str,
        stay_search: StaySearchService | None = None,
        trip_planner: TripPlanner | None = None,
        prompts_dir: Path | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._airports = airports
        self._search = search
        self._stay_search = stay_search
        self._trip_planner = trip_planner
        self._model = model
        self._systems = {mode: _system_prompt(prompts_dir, mode) for mode in ROLE_PROMPTS}
        self._clock = clock or (lambda: datetime.now(UTC))

    async def reply(
        self,
        turns: Sequence[ChatTurn],
        context: ChatContext,
        llm: LLMClient,
        mode: ChatMode = "flights",
    ) -> ChatReply:
        """`turns` закінчується реплікою користувача; `llm` — з лімітом викликів на репліку."""
        turns = list(turns)[-MAX_CHAT_TURNS:]
        state = _TurnState()
        if (mode == "stays" and self._stay_search is None) or (
            mode == "trip" and self._trip_planner is None
        ):
            return ChatReply(status="unavailable")
        context_json = context.model_dump_json(exclude_none=True)
        system = self._systems[mode]
        messages = [
            Message("system", f"{system}\n\n{CONTEXT_MARKER}\n{context_json}"),
            *(Message(t.role, t.text) for t in turns),
        ]
        try:
            for _attempt in range(2):
                text = await self._run(messages, state, context, llm, mode)
                allowed = allowed_numbers(
                    {
                        "context": context_json,
                        "turns": [t.text for t in turns],
                        "tools": state.tool_outputs,
                    }
                )
                problem = _problem(text, allowed)
                if problem is None:
                    return ChatReply(
                        status="ok",
                        reply=text[:MAX_TURN_LENGTH],
                        search=state.search,
                        stay_search=state.stay_search,
                        trip_search=state.trip_search,
                    )
                log.info("ai.chat.rejected_attempt", mode=mode)
                messages += [Message("assistant", text), Message("user", problem)]
        except LLMError as exc:
            log.warning("ai.chat.llm_failed", error=exc.message, mode=mode)
            return ChatReply(
                status="unavailable",
                search=state.search,
                stay_search=state.stay_search,
                trip_search=state.trip_search,
            )
        return ChatReply(
            status="fallback",
            search=state.search,
            stay_search=state.stay_search,
            trip_search=state.trip_search,
        )

    async def _run(
        self,
        messages: list[Message],
        state: _TurnState,
        context: ChatContext,
        llm: LLMClient,
        mode: ChatMode,
    ) -> str:
        # Цикл обмежує MeteredLLM (ліміт викликів на репліку): вичерпав — LLMError.
        while True:
            response = await llm.chat(
                ChatRequest(
                    model=self._model,
                    messages=tuple(messages),
                    tools=TOOLS_BY_MODE[mode],
                    max_tokens=700,
                    temperature=0.3,
                )
            )
            if not response.tool_calls:
                return response.content.strip()
            messages.append(Message("assistant", response.content, response.tool_calls))
            for call in response.tool_calls:
                output = await self._tool(call, state, context, mode)
                state.tool_outputs.append(output)
                messages.append(Message("tool", output, tool_call_id=call.id))

    async def _tool(
        self, call: ToolCall, state: _TurnState, context: ChatContext, mode: ChatMode
    ) -> str:
        try:
            arguments = json.loads(call.arguments or "{}")
            if not isinstance(arguments, dict):
                raise ToolError("arguments must be a JSON object")
            # Інструмент іншого режиму — як невідомий: чати не змішуються.
            if call.name not in {t.name for t in TOOLS_BY_MODE[mode]}:
                raise ToolError(f"unknown tool {call.name}")
            if call.name == LOOKUP_TOOL.name:
                return lookup_airport(self._airports, call.arguments)
            if call.name == SEARCH_TOOL.name:
                return await self._search_flights(arguments, state, context)
            if call.name == CALENDAR_TOOL.name:
                return await self._calendar(arguments, context)
            if call.name == STAY_SEARCH_TOOL.name:
                return await self._search_stays(arguments, state, context)
            if call.name == PLAN_TRIP_TOOL.name:
                return await self._plan_trip(arguments, state, context)
            raise ToolError(f"unknown tool {call.name}")
        except (ToolError, ValueError) as exc:  # ValidationError — теж ValueError
            message = _validation_text(exc) if isinstance(exc, ValidationError) else str(exc)
            return json.dumps({"error": message}, ensure_ascii=False)

    async def _search_flights(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        args = _SearchArgs.model_validate(arguments)
        origin, destination = self._code(args.origin), self._code(args.destination)
        if args.departure_date < context.today:
            raise ToolError("departure_date is in the past")
        current = context.current_search
        query = FlightQuery(
            origin=origin,
            destination=destination,
            departure_date=args.departure_date,
            return_date=args.return_date,
            flex_days=args.flex_days,
            passengers={"adults": args.adults},
            direct_only=args.direct_only,
            currency=context.currency,
            profile=args.profile,
            filters={"max_price": args.max_price},
            # Сусідні аеропорти, увімкнені у формі, не губимо, поки маршрут той самий.
            origin_radius_km=current.origin_radius_km
            if current and current.origin == origin
            else 0,
            destination_radius_km=current.destination_radius_km
            if current and current.destination == destination
            else 0,
        )
        if query != current:  # поточні результати — з кешу, ліміт не витрачаємо
            if state.searches >= MAX_SEARCHES_PER_TURN:
                raise ToolError("search limit for this reply reached; answer with what you have")
            state.searches += 1
        result = await self._search.search(query)
        state.search = query
        payload = advisor_input(query, result, now=self._clock(), price_stats=None)
        for option in payload["options"]:
            # Суми штрафів скорингу користувачу нічого не кажуть — лишаємо самі ризики.
            breakdown = option.pop("score_breakdown") or {}
            option["risks"] = [
                {"code": r["code"], "airport": r["airport"]}
                for r in breakdown.get("risk_penalties", [])
            ]
        payload["offers_found"] = len(result.offers)
        payload["sources_failed"] = [p.provider for p in result.providers if p.status != "ok"]
        payload["prices_are"] = "total for all passengers of the search"
        return json.dumps(payload, ensure_ascii=False)

    async def _search_stays(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        if self._stay_search is None:
            raise ToolError("stays search is not available")
        args = _StayArgs.model_validate(arguments)
        city = self._airports.city_of(args.city.strip())
        if city is None:
            raise ToolError(f"unknown city code {args.city!r}: use lookup_airport")
        if args.check_in < context.today:
            raise ToolError("check_in is in the past")
        query = StayQuery(
            city=city.code,
            check_in=args.check_in,
            check_out=args.check_out,
            guests={"adults": args.adults, "children": args.children},
            currency=context.currency,
            profile=args.priority,
            filters={"max_price_per_night": args.max_price_per_night},
        )
        if state.stay_searches >= MAX_STAY_SEARCHES_PER_TURN:
            raise ToolError("search limit for this reply reached; answer with what you have")
        state.stay_searches += 1
        result = await self._stay_search.search(query)
        state.stay_search = query
        return json.dumps(stay_options_input(query, result), ensure_ascii=False)

    async def _plan_trip(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        if self._trip_planner is None:
            raise ToolError("trip planning is not available")
        args = _TripArgs.model_validate(arguments)
        origin, destination = self._code(args.origin), self._code(args.destination)
        if args.departure_date < context.today:
            raise ToolError("departure_date is in the past")
        query = TripQuery(
            origin=origin,
            destination=destination,
            departure_date=args.departure_date,
            return_date=args.return_date,
            adults=args.adults,
            children=args.children,
            budget_total=args.budget_total,
            profile=args.priority,
            currency=context.currency,
        )
        # Поїздка — це живий пошук перельотів: той самий ліміт, що й для search_flights.
        if state.searches >= MAX_SEARCHES_PER_TURN:
            raise ToolError("search limit for this reply reached; answer with what you have")
        state.searches += 1
        result = await self._trip_planner.plan(query)
        state.trip_search = query
        known = self._search.airline_names
        names = {c: known.get(c, c) for o in result.offers for c in o.airlines}
        return json.dumps(trip_input(result, names), ensure_ascii=False)

    async def _calendar(self, arguments: dict[str, Any], context: ChatContext) -> str:
        args = _CalendarArgs.model_validate(arguments)
        origin, destination = self._code(args.origin), self._code(args.destination)
        month = date.fromisoformat(f"{args.month}-01")
        result = await self._search.calendar(origin, destination, month, context.currency)
        days = [d for d in result.days if d.date >= context.today and d.date.month == month.month]
        now = self._clock()
        cheapest = sorted(days, key=lambda d: (d.price, d.date))[:CALENDAR_DAYS_SHOWN]
        return json.dumps(
            {
                "origin": origin,
                "destination": destination,
                "month": args.month,
                "days_with_prices": len(days),
                "cheapest_days": [
                    {
                        "date": d.date.isoformat(),
                        "price_text": money_text(d.price, d.currency),
                        "stops": d.stops,
                        "price_age_text": age_text(now - (d.found_at or d.collected_at)),
                    }
                    for d in sorted(cheapest, key=lambda d: d.date)
                ],
                "note": "approximate one-way prices from cached searches, not live",
            },
            ensure_ascii=False,
        )

    def _code(self, value: str) -> str:
        code = value.strip().upper()
        if not self._airports.knows(code):
            raise ToolError(f"unknown IATA code {value!r}: use lookup_airport")
        return code


def _problem(text: str, allowed: frozenset[str]) -> str | None:
    """Порушення, яке модель може виправити з другої спроби."""
    if not text:
        return "Відповідь порожня. Напиши відповідь користувачу текстом."
    invented = numbers_in(text) - allowed
    if invented:
        return (
            f"Перевірка сервісу: у відповіді є числа, яких немає в результатах інструментів "
            f"чи в розмові: {', '.join(sorted(invented))}. Перепиши відповідь лише з готовими "
            "значеннями (price_text, duration_text, comparisons) і нічого не рахуй сам."
        )
    return None


def _validation_text(exc: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, e['loc'])) or 'query'}: {e['msg']}" for e in exc.errors())


@lru_cache
def _system_prompt(prompts_dir: Path | None, mode: ChatMode) -> str:
    """rules/rules.md власника + роль чату (їх немає в sub-agents/ — вони в коді)."""
    root = prompts_dir or find_prompts_dir()
    rules = (root / RULES).read_text(encoding="utf-8").strip()
    role = (PROMPTS_DIR / ROLE_PROMPTS[mode]).read_text(encoding="utf-8").strip()
    return f"{rules}\n\n{role}"
