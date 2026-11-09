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
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from tickets_api.ai.cards import (
    ChatCard,
    flight_cards,
    stay_cards,
    trip_card,
    trip_cards,
)
from tickets_api.ai.explainer import (
    advisor_input,
    age_text,
    allowed_numbers,
    money_text,
    numbers_in,
)
from tickets_api.ai.parser import LOOKUP_TOOL, lookup_airport
from tickets_api.ai.refine import (
    FlightRefinement,
    StayRefinement,
    TripChange,
    refine_flights,
    refine_stays,
    refine_trip,
)
from tickets_api.ai.stay_payload import stay_options_input
from tickets_api.ai.trip_payload import combo_facts, trip_input
from tickets_api.domain.flights import DEFAULT_CURRENCY, MAX_FLEX_DAYS, FlightQuery
from tickets_api.domain.locale import DEFAULT_AI_LOCALE, UiLocale
from tickets_api.domain.saved_trips import SavedTripBody, TripSnapshot
from tickets_api.domain.stays import StayQuery
from tickets_api.domain.trips import TripPreferences, TripQuery
from tickets_api.i18n import Labels, t, use_locale
from tickets_api.llm.prompts import RULES, find_prompts_dir
from tickets_api.llm.types import ChatRequest, LLMClient, LLMError, Message, Tool, ToolCall
from tickets_api.reference.airports import AirportDirectory
from tickets_api.scoring.engine import offer_key
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import (
    TripCombo,
    TripPlanner,
    TripSearchResult,
    current_combo,
    pick_flight,
    pick_stay,
    trip_snapshot,
)

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

REFINE_FLIGHTS_TOOL = Tool(
    name="refine_flights",
    description=(
        "Change the CURRENT flight search (the one on the page or your last search) and run "
        "it again. Pass ONLY what the user wants to change; everything else is kept. "
        "Relative budget changes go to max_price_change (the service adds it)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "origin": {"type": "string", "description": "IATA code from lookup_airport"},
            "destination": {"type": "string", "description": "IATA code from lookup_airport"},
            "departure_date": {"type": "string", "description": "YYYY-MM-DD"},
            "return_date": {"type": "string", "description": "YYYY-MM-DD"},
            "one_way": {"type": "boolean", "description": "true — remove the return flight"},
            "flex_days": {"type": "integer", "minimum": 0, "maximum": MAX_FLEX_DAYS},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "direct_only": {"type": "boolean"},
            "max_stops": {"type": "integer", "minimum": 0, "maximum": 3},
            "departure_after": {
                "type": "integer",
                "minimum": 0,
                "maximum": 23,
                "description": "outbound departs at or after this hour (local)",
            },
            "departure_before": {"type": "integer", "minimum": 1, "maximum": 24},
            "return_departure_after": {"type": "integer", "minimum": 0, "maximum": 23},
            "return_departure_before": {"type": "integer", "minimum": 1, "maximum": 24},
            "max_price": {"type": "integer", "description": "Max ticket price per passenger"},
            "max_price_change": {
                "type": "integer",
                "description": "Change the current max price by this amount",
            },
            "max_total_price": {"type": "integer", "description": "Max price for all passengers"},
            "airlines": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Only these airline IATA codes",
            },
            "exclude_airlines": {"type": "array", "items": {"type": "string"}},
            "baggage": {
                "type": "string",
                "enum": ["none", "personal_item", "carry_on", "checked", "checked_extra"],
            },
            "cabin": {
                "type": "string",
                "enum": ["economy", "premium_economy", "business", "first"],
            },
            "profile": {"type": "string", "enum": ["budget", "balanced", "time_is_money"]},
            "clear": {
                "type": "array",
                "items": {"type": "string", "enum": ["stops", "times", "price", "airlines"]},
                "description": "Remove these filters",
            },
        },
    },
)

REFINE_STAYS_TOOL = Tool(
    name="refine_stays",
    description=(
        "Change the CURRENT stay search and run it again. Pass ONLY what changes; everything "
        "else is kept. Relative price changes go to max_price_change."
    ),
    parameters={
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City or airport IATA code"},
            "check_in": {"type": "string", "description": "YYYY-MM-DD"},
            "check_out": {"type": "string", "description": "YYYY-MM-DD"},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "max_price_per_night": {"type": "integer"},
            "max_price_change": {"type": "integer"},
            "min_rating": {"type": "number", "minimum": 0, "maximum": 10},
            "max_distance_km": {"type": "number", "description": "Max km to the center"},
            "free_cancellation": {"type": "boolean"},
            "breakfast_included": {"type": "boolean"},
            "kinds": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["hotel", "apartment", "hostel", "guesthouse", "other"],
                },
            },
            "priority": {"type": "string", "enum": ["budget", "balanced", "center"]},
            "clear": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["price", "rating", "distance", "conditions", "kinds"],
                },
            },
        },
    },
)

PLAN_TRIP_TOOL = Tool(
    name="plan_trip",
    description=(
        "Plan a whole trip: round-trip flights plus a place to stay from the arrival day "
        "to the return flight day. Returns up to 3 trips (Economy, Optimal, Comfort) with "
        "the total price and its breakdown already calculated. Exact dates "
        "(departure_date + return_date) or a flexible window (departure_date..departure_until "
        "with min_nights/max_nights)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "origin": {"type": "string", "description": "IATA code from lookup_airport"},
            "destination": {"type": "string", "description": "IATA code from lookup_airport"},
            "departure_date": {"type": "string", "description": "YYYY-MM-DD (earliest)"},
            "return_date": {"type": "string", "description": "YYYY-MM-DD; omit with nights"},
            "departure_until": {"type": "string", "description": "YYYY-MM-DD, latest departure"},
            "min_nights": {"type": "integer", "minimum": 1, "maximum": 30},
            "max_nights": {"type": "integer", "minimum": 1, "maximum": 30},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "budget_total": {"type": "integer", "description": "Budget for the whole trip"},
            "priority": {"type": "string", "enum": ["budget", "balanced", "comfort"]},
            "direct_only": {"type": "boolean"},
            "baggage": {
                "type": "string",
                "enum": ["none", "personal_item", "carry_on", "checked", "checked_extra"],
            },
            "stay_min_rating": {"type": "number", "minimum": 0, "maximum": 10},
            "stay_max_distance_km": {"type": "number", "description": "Max km to the center"},
            "stay_free_cancellation": {"type": "boolean"},
            "stay_breakfast": {"type": "boolean"},
            "stay_kinds": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["hotel", "apartment", "hostel", "guesthouse", "other"],
                },
                "description": "Only these kinds of places ('hotel' when the user says hotel)",
            },
        },
        "required": ["origin", "destination", "departure_date"],
    },
)

CHANGE_TRIP_TOOL = Tool(
    name="change_trip",
    description=(
        "Change the CURRENT trip (the one on the page or your last plan). flight/stay: "
        "'keep' leaves it as is; 'cheaper', 'faster', 'fewer_stops', 'closer_to_center', "
        "'better_rating' — the service picks the replacement among the options it found. "
        "Pass only what changes. Returns the trip before and after and what changed."
    ),
    parameters={
        "type": "object",
        "properties": {
            "flight": {"type": "string", "enum": ["keep", "cheaper", "faster", "fewer_stops"]},
            "stay": {
                "type": "string",
                "enum": ["keep", "cheaper", "closer_to_center", "better_rating"],
            },
            "budget_total": {"type": "integer"},
            "budget_change": {"type": "integer", "description": "Add this to the current budget"},
            "departure_date": {"type": "string", "description": "YYYY-MM-DD"},
            "return_date": {"type": "string", "description": "YYYY-MM-DD"},
            "adults": {"type": "integer", "minimum": 1, "maximum": 9},
            "children": {"type": "integer", "minimum": 0, "maximum": 8},
            "direct_only": {"type": "boolean"},
            "stay_min_rating": {"type": "number", "minimum": 0, "maximum": 10},
            "stay_max_distance_km": {"type": "number"},
            "stay_free_cancellation": {"type": "boolean"},
            "stay_breakfast": {"type": "boolean"},
        },
    },
)

UNDO_TRIP_TOOL = Tool(
    name="undo_trip",
    description="Return the trip page to the previous variant (the step before the last change).",
    parameters={"type": "object", "properties": {}},
)

TRIP_REFS = ["current", "previous", "cheapest", "best_value", "comfort"]
COMPARE_TRIPS_TOOL = Tool(
    name="compare_trips",
    description=(
        "Compare two trips side by side: 'current' (on the page), 'previous' (before the "
        "last change), or a scenario of the current search ('cheapest' = Economy, "
        "'best_value' = Optimal, 'comfort' = Comfort). Differences are calculated by the "
        "service; both trips are also added to the comparison panel on the page."
    ),
    parameters={
        "type": "object",
        "properties": {
            "first": {"type": "string", "enum": TRIP_REFS},
            "second": {"type": "string", "enum": TRIP_REFS},
        },
        "required": ["first", "second"],
    },
)

SAVE_TRIP_TOOL = Tool(
    name="save_trip",
    description=(
        "Save the current trip (flight, stay, prices now) to the user's trips: in the account "
        "if signed in, otherwise in this browser."
    ),
    parameters={
        "type": "object",
        "properties": {"title": {"type": "string", "maxLength": 120}},
    },
)

ChatMode = Literal["flights", "stays", "trip"]
"""Окремі чати: квитки, житло, уся поїздка — свої промпт, інструменти й історія."""
TOOLS_BY_MODE: dict[ChatMode, tuple[Tool, ...]] = {
    "flights": (LOOKUP_TOOL, SEARCH_TOOL, REFINE_FLIGHTS_TOOL, CALENDAR_TOOL),
    "stays": (LOOKUP_TOOL, STAY_SEARCH_TOOL, REFINE_STAYS_TOOL),
    "trip": (
        LOOKUP_TOOL,
        PLAN_TRIP_TOOL,
        CHANGE_TRIP_TOOL,
        UNDO_TRIP_TOOL,
        COMPARE_TRIPS_TOOL,
        SAVE_TRIP_TOOL,
    ),
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
    current_trip: TripQuery | None = None
    """Поїздка, відкрита на сторінці планувальника (з вибором рейсу й житла, якщо є)."""
    previous_trip: TripQuery | None = None
    """Попередній крок поїздки (історія вкладки) — для «порівняй з попереднім»."""
    currency: str = DEFAULT_CURRENCY
    """Валюта пошуків помічника — з профілю (модуль 15: налаштування кабінету скрізь)."""
    preferences: TripPreferences | None = None
    """М'які уподобання з профілю: ті самі, що у формах перельотів, житла й поїздки."""
    locale: UiLocale = DEFAULT_AI_LOCALE
    """Мова інтерфейсу: нею відповідає модель (rules.md, п. 5)."""


class CompareEntry(BaseModel):
    """Поїздка для панелі порівняння сторінки (знімок рахує код)."""

    key: str
    title: str
    snapshot: TripSnapshot


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
    trip_action: Literal["undo"] | None = None
    """«Поверни попередній варіант»: UI повертає сторінку поїздки на крок назад."""
    save_trip: SavedTripBody | None = None
    """«Збережи»: UI зберігає (акаунт чи браузер — як кнопка «Зберегти поїздку»)."""
    compare: list[CompareEntry] = []
    """«Порівняй»: UI додає ці поїздки до панелі порівняння."""
    cards: list[ChatCard] = []
    """Картки останнього результату репліки (модуль 9b) — будує код, не модель."""


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
    return_date: date | None = None
    departure_until: date | None = None
    min_nights: int | None = Field(default=None, ge=1, le=30)
    max_nights: int | None = Field(default=None, ge=1, le=30)
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    budget_total: int | None = Field(default=None, ge=1)
    priority: Literal["budget", "balanced", "comfort"] = "balanced"
    direct_only: bool = False
    baggage: Literal["none", "personal_item", "carry_on", "checked", "checked_extra"] = "none"
    stay_min_rating: float | None = Field(default=None, ge=0, le=10)
    stay_max_distance_km: float | None = Field(default=None, gt=0, le=100)
    stay_free_cancellation: bool = False
    stay_breakfast: bool = False
    stay_kinds: list[Literal["hotel", "apartment", "hostel", "guesthouse", "other"]] = []


class _CompareArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    first: Literal["current", "previous", "cheapest", "best_value", "comfort"]
    second: Literal["current", "previous", "cheapest", "best_value", "comfort"]


class _SaveArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str | None = Field(default=None, max_length=120)


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
    trip_action: Literal["undo"] | None = None
    save_trip: SavedTripBody | None = None
    compare: list[CompareEntry] = field(default_factory=list)
    cards: list[ChatCard] = field(default_factory=list)
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
        """`turns` закінчується реплікою користувача; `llm` — з лімітом викликів на репліку.
        Тексти в результатах інструментів і картках — мовою розмови (модуль 18.1)."""
        with use_locale(context.locale):
            return await self._reply(turns, context, llm, mode)

    async def _reply(
        self,
        turns: Sequence[ChatTurn],
        context: ChatContext,
        llm: LLMClient,
        mode: ChatMode,
    ) -> ChatReply:
        turns = list(turns)[-MAX_CHAT_TURNS:]
        state = _TurnState()
        if (mode == "stays" and self._stay_search is None) or (
            mode == "trip" and self._trip_planner is None
        ):
            return ChatReply(status="unavailable")
        # Уподобання застосовує код (скоринг) — моделі їх не передаємо: мінімум даних.
        context_json = context.model_dump_json(exclude_none=True, exclude={"preferences"})
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
                    return ChatReply(status="ok", reply=text[:MAX_TURN_LENGTH], **_effects(state))
                log.info("ai.chat.rejected_attempt", mode=mode)
                messages += [Message("assistant", text), Message("user", problem)]
        except LLMError as exc:
            log.warning("ai.chat.llm_failed", error=exc.message, mode=mode)
            return ChatReply(status="unavailable", **_effects(state))
        return ChatReply(status="fallback", **_effects(state))

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
            if call.name == REFINE_FLIGHTS_TOOL.name:
                return await self._refine_flights(arguments, state, context)
            if call.name == REFINE_STAYS_TOOL.name:
                return await self._refine_stays(arguments, state, context)
            if call.name == PLAN_TRIP_TOOL.name:
                return await self._plan_trip(arguments, state, context)
            if call.name == CHANGE_TRIP_TOOL.name:
                return await self._change_trip(arguments, state, context)
            if call.name == UNDO_TRIP_TOOL.name:
                return self._undo_trip(state, context)
            if call.name == COMPARE_TRIPS_TOOL.name:
                return await self._compare_trips(arguments, state, context)
            if call.name == SAVE_TRIP_TOOL.name:
                return await self._save_trip(arguments, state, context)
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
            preferences=context.preferences.flights if context.preferences else None,
            # Сусідні аеропорти, увімкнені у формі, не губимо, поки маршрут той самий.
            origin_radius_km=current.origin_radius_km
            if current and current.origin == origin
            else 0,
            destination_radius_km=current.destination_radius_km
            if current and current.destination == destination
            else 0,
        )
        return await self._run_flights(query, state, context)

    async def _refine_flights(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        current = state.search or context.current_search
        if current is None:
            raise ToolError("there is no current flight search; use search_flights")
        change = FlightRefinement.model_validate(arguments)
        for key in ("origin", "destination"):
            value = getattr(change, key)
            if value is not None:
                change = change.model_copy(update={key: self._code(value)})
        if change.departure_date is not None and change.departure_date < context.today:
            raise ToolError("departure_date is in the past")
        query = refine_flights(current, change)
        return await self._run_flights(query, state, context)

    async def _run_flights(
        self, query: FlightQuery, state: _TurnState, context: ChatContext
    ) -> str:
        current = context.current_search
        if query != current:  # поточні результати — з кешу, ліміт не витрачаємо
            if state.searches >= MAX_SEARCHES_PER_TURN:
                raise ToolError("search limit for this reply reached; answer with what you have")
            state.searches += 1
        result = await self._search.search(query)
        state.search = query
        state.cards = list(flight_cards(query, result, self._search.airline_names))
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
        payload["active_filters"] = query.filters.model_dump(exclude_defaults=True, mode="json")
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
            preferences=context.preferences.stays if context.preferences else None,
        )
        return await self._run_stays(query, state)

    async def _refine_stays(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        if self._stay_search is None:
            raise ToolError("stays search is not available")
        current = state.stay_search or context.current_stay_search
        if current is None:
            raise ToolError("there is no current stay search; use search_stays")
        change = StayRefinement.model_validate(arguments)
        if change.city is not None:
            city = self._airports.city_of(change.city.strip())
            if city is None:
                raise ToolError(f"unknown city code {change.city!r}: use lookup_airport")
            change = change.model_copy(update={"city": city.code})
        if change.check_in is not None and change.check_in < context.today:
            raise ToolError("check_in is in the past")
        return await self._run_stays(refine_stays(current, change), state)

    async def _run_stays(self, query: StayQuery, state: _TurnState) -> str:
        if self._stay_search is None:
            raise ToolError("stays search is not available")
        if state.stay_searches >= MAX_STAY_SEARCHES_PER_TURN:
            raise ToolError("search limit for this reply reached; answer with what you have")
        state.stay_searches += 1
        result = await self._stay_search.search(query)
        state.stay_search = query
        state.cards = list(stay_cards(result))
        payload = stay_options_input(query, result)
        payload["active_filters"] = query.filters.model_dump(exclude_defaults=True, mode="json")
        return json.dumps(payload, ensure_ascii=False)

    async def _plan_trip(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        if self._trip_planner is None:
            raise ToolError("trip planning is not available")
        args = _TripArgs.model_validate(arguments)
        origin, destination = self._code(args.origin), self._code(args.destination)
        if args.departure_date < context.today:
            raise ToolError("departure_date is in the past")
        nights = (
            {"min_nights": args.min_nights, "max_nights": args.max_nights or args.min_nights}
            if args.min_nights
            else {}
        )
        query = TripQuery.model_validate(
            {
                "origin": origin,
                "destination": destination,
                "departure_date": args.departure_date,
                "return_date": None if nights else args.return_date,
                "departure_until": args.departure_until,
                **nights,
                "adults": args.adults,
                "children": args.children,
                "budget_total": args.budget_total,
                "profile": args.priority,
                "direct_only": args.direct_only,
                "baggage": args.baggage,
                "stay_filters": {
                    "min_rating": args.stay_min_rating,
                    "max_distance_center_km": args.stay_max_distance_km,
                    "free_cancellation": args.stay_free_cancellation,
                    "breakfast_included": args.stay_breakfast,
                    "kinds": args.stay_kinds,
                },
                "currency": context.currency,
                "preferences": context.preferences,
            }
        )
        self._count_search(state)
        result = await self._trip_planner.plan(query)
        state.trip_search = query
        names = self._names(result)
        state.cards = list(trip_cards(query, result, names, dict(TRIP_REF_TITLES)))
        return json.dumps(trip_input(result, names), ensure_ascii=False)

    def _count_search(self, state: _TurnState) -> None:
        # Поїздка — це живий пошук перельотів: той самий ліміт, що й для search_flights.
        if state.searches >= MAX_SEARCHES_PER_TURN:
            raise ToolError("search limit for this reply reached; answer with what you have")
        state.searches += 1

    def _names(self, result: TripSearchResult) -> dict[str, str]:
        known = self._search.airline_names
        return {c: known.get(c, c) for o in result.offers for c in o.airlines}

    def _current_trip(self, state: _TurnState, context: ChatContext) -> TripQuery:
        current = state.trip_search or context.current_trip
        if current is None:
            raise ToolError("there is no current trip; plan it with plan_trip first")
        return current

    async def _change_trip(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        """Зміна поїздки: умови — кодом (refine_trip), заміна рейсу чи житла — вибір кодом серед
        варіантів планувальника за побажанням. Модель лише каже, що змінити."""
        planner = self._planner()
        change = TripChange.model_validate(arguments)
        if change.departure_date is not None and change.departure_date < context.today:
            raise ToolError("departure_date is in the past")
        query = refine_trip(self._current_trip(state, context), change)
        self._count_search(state)
        result = await planner.plan(query)
        before = current_combo(result)
        if before is None:
            state.trip_search = query
            return json.dumps({"found": False, "note": "no trips for these conditions"})
        before_facts = combo_facts(
            before, _offer_of(result, before), result.stays[before.stay_index], self._names(result)
        )
        # Закріплюємо поточний вибір: «не змінюй авіаквитки» — рейс лишається тим самим.
        pinned = query.model_copy(update={"flight": before.offer_key, "stay": before.stay_key})
        not_found: list[str] = []
        if change.flight not in (None, "keep"):
            base = result if result.selected else await planner.plan(pinned)
            new_flight = pick_flight(base, base.selected or before, change.flight)
            if new_flight is None:
                not_found.append("flight")
            else:
                pinned = pinned.model_copy(update={"flight": new_flight})
        if change.stay not in (None, "keep"):
            base = await planner.plan(pinned)
            now = base.selected or before
            new_stay = pick_stay(base, now, change.stay)
            if new_stay is None:
                not_found.append("stay")
            else:
                pinned = pinned.model_copy(update={"stay": new_stay})
        final = await planner.plan(pinned)
        after = final.selected or current_combo(final)
        state.trip_search = pinned
        if after is None:
            return json.dumps({"found": False, "note": "no trips for these conditions"})
        state.cards = [
            trip_card(pinned, final, after, self._names(final), t("ai.trip_label.after_change"))
        ]
        currency = after.currency
        diff = after.money_total - before.money_total
        return json.dumps(
            {
                "found": True,
                "before": before_facts,
                "after": combo_facts(
                    after,
                    _offer_of(final, after),
                    final.stays[after.stay_index],
                    self._names(final),
                ),
                "difference_text": ("+" if diff > 0 else "") + money_text(diff, currency),
                "flight_changed": after.offer_key != before.offer_key,
                "stay_changed": after.stay_key != before.stay_key,
                "no_better_option_found": not_found,
                "budget_text": money_text(Decimal(pinned.budget_total), currency)
                if pinned.budget_total
                else None,
                "over_budget": pinned.budget_total is not None
                and after.money_total > pinned.budget_total,
                "note": "options checked are only those found by this search, not the whole market",
            },
            ensure_ascii=False,
        )

    def _undo_trip(self, state: _TurnState, context: ChatContext) -> str:
        if context.previous_trip is None:
            raise ToolError("there is no previous variant of this trip")
        state.trip_action = "undo"
        state.trip_search = None
        return json.dumps({"ok": True, "note": "the page returns to the previous variant"})

    async def _compare_trips(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        planner = self._planner()
        args = _CompareArgs.model_validate(arguments)
        plans: dict[str, TripSearchResult] = {}
        self._count_search(state)

        async def plan(query: TripQuery) -> TripSearchResult:
            key = query.model_dump_json()
            if key not in plans:
                plans[key] = await planner.plan(query)
            return plans[key]

        async def resolve(ref: str) -> tuple[str, TripCombo, TripSearchResult]:
            if ref == "previous":
                if context.previous_trip is None:
                    raise ToolError("there is no previous variant of this trip")
                result = await plan(context.previous_trip)
                combo = current_combo(result)
            else:
                result = await plan(self._current_trip(state, context))
                if ref == "current":
                    combo = current_combo(result)
                else:
                    key = next(
                        (p.combo_key for p in result.picks if p.label == ref or ref in p.also),
                        None,
                    )
                    combo = next((c for c in result.combos if c.key == key), None)
            if combo is None:
                raise ToolError(f"trip {ref!r} is not available")
            return TRIP_REF_TITLES[ref], combo, result

        first = await resolve(args.first)
        second = await resolve(args.second)
        now = self._clock()
        state.compare = [
            CompareEntry(
                key=combo.key,
                title=title,
                snapshot=trip_snapshot(
                    combo, _offer_of(result, combo), result.stays[combo.stay_index], now
                ),
            )
            for title, combo, result in (first, second)
        ]
        state.cards = [
            trip_card(self._current_trip(state, context), result, combo, self._names(result), title)
            for title, combo, result in (first, second)
        ]
        a, b = first[1], second[1]
        diff = b.money_total - a.money_total
        return json.dumps(
            {
                "first": {
                    "title": first[0],
                    **combo_facts(
                        a,
                        _offer_of(first[2], a),
                        first[2].stays[a.stay_index],
                        self._names(first[2]),
                    ),
                },
                "second": {
                    "title": second[0],
                    **combo_facts(
                        b,
                        _offer_of(second[2], b),
                        second[2].stays[b.stay_index],
                        self._names(second[2]),
                    ),
                },
                "second_minus_first_text": ("+" if diff > 0 else "") + money_text(diff, a.currency),
                "note": "both trips were added to the comparison panel on the page",
            },
            ensure_ascii=False,
        )

    async def _save_trip(
        self, arguments: dict[str, Any], state: _TurnState, context: ChatContext
    ) -> str:
        planner = self._planner()
        args = _SaveArgs.model_validate(arguments)
        query = self._current_trip(state, context)
        self._count_search(state)
        result = await planner.plan(query)
        combo = current_combo(result)
        if combo is None:
            raise ToolError("there is no trip to save for these conditions")
        title = (args.title or "").strip() or (
            f"{query.origin} → {query.destination} · "
            f"{combo.window.check_in:%d.%m}–{combo.window.check_out:%d.%m}"
        )
        state.cards = [trip_card(query, result, combo, self._names(result), title[:120])]
        state.save_trip = SavedTripBody(
            title=title[:120],
            query=query.model_copy(update={"flight": combo.offer_key, "stay": combo.stay_key}),
            snapshot=trip_snapshot(
                combo, _offer_of(result, combo), result.stays[combo.stay_index], self._clock()
            ),
        )
        return json.dumps(
            {
                "ok": True,
                "title": title,
                "money_total_text": money_text(combo.money_total, combo.currency),
                "note": "saved with today's prices; refresh later on the My trips page",
            },
            ensure_ascii=False,
        )

    def _planner(self) -> TripPlanner:
        if self._trip_planner is None:
            raise ToolError("trip planning is not available")
        return self._trip_planner

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


TRIP_REF_TITLES = Labels(
    "ai.trip_label", ("current", "previous", "cheapest", "best_value", "comfort")
)
"""Назви поїздок у порівнянні й картках — мовою розмови (модуль 18.1)."""


def _offer_of(result: TripSearchResult, combo: TripCombo) -> Any:
    return next(o for o in result.offers if offer_key(o) == combo.offer_key)


def _effects(state: _TurnState) -> dict[str, Any]:
    """Що UI має зробити після репліки: відкрити пошук, змінити поїздку, зберегти, порівняти."""
    return {
        "search": state.search,
        "stay_search": state.stay_search,
        "trip_search": state.trip_search,
        "trip_action": state.trip_action,
        "save_trip": state.save_trip,
        "compare": state.compare,
        "cards": state.cards,
    }


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
