"""Розбір запиту природною мовою → FlightQuery (роль Query-Parser, sub-agents/).

Модель лише ВИТЯГУЄ поля з тексту. Усе, що можна перевірити, перевіряє код:
- IATA-коди — тільки з нашого довідника (інструмент `lookup_airport`); код, якого
  довідник не знає, вважаємо нерозпізнаним, а не довіряємо пам'яті моделі;
- дати, пасажири, фільтри — через Pydantic-моделі FlightQuery/OfferFilters;
- якщо назвали лише місяць — день вильоту обирає КОД за календарем цін, не модель.
"""

import hashlib
import json
from collections.abc import Awaitable, Callable, Sequence
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Literal

import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from tickets_api.domain.flights import (
    DEFAULT_CURRENCY,
    MAX_FLEX_DAYS,
    DeparturePeriod,
    FlightQuery,
    OfferFilters,
)
from tickets_api.llm.prompts import system_prompt
from tickets_api.llm.types import ChatRequest, LLMClient, LLMError, Message, Tool
from tickets_api.reference.airports import AirportDirectory

log = structlog.get_logger(__name__)

MAX_MESSAGE_LENGTH = 500
MAX_HISTORY_TURNS = 6
"""Попередні репліки діалогу уточнень: до трьох пар «запит — питання моделі»."""
LOOKUP_LIMIT = 6
MONTH_ONLY_FLEX_DAYS = 3
"""Промпт Query-Parser: «якщо вказано лише місяць — flex_days за замовчуванням 3»."""

# Cheapest-day picker: (origin, destination, from, to) → найдешевший день або None.
CheapestDay = Callable[[str, str, date, date], Awaitable[date | None]]

LOOKUP_TOOL = Tool(
    name="lookup_airport",
    description=(
        "Search the airport directory by city or airport name (any language) or IATA code. "
        "Returns matching places with IATA codes. kind=city means all airports of the city."
    ),
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string", "description": "City or airport name"}},
        "required": ["query"],
    },
)

# Технічний контракт поверх промпту власника: точні типи полів, яких там немає.
OUTPUT_CONTRACT = """
# ТЕХНІЧНИЙ КОНТРАКТ ВІДПОВІДІ
Відповідай одним JSON-об'єктом точно в такій формі (null там, де даних немає):
{
  "intent": "flights" | "stays" | "both" | "out_of_scope",
  "origin": {"raw": str, "iata": str | null, "type": "airport" | "city" | null} | null,
  "destination": {"raw": str, "iata": str | null, "type": "airport" | "city" | null} | null,
  "dates": {
    "departure": "YYYY-MM-DD" | null,
    "departure_range": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} | null,
    "return": "YYYY-MM-DD" | null,
    "flex_days": 0-7 | null,
    "trip_length_days": int | null
  },
  "passengers": {"adults": int, "children": int, "infants": int},
  "budget": {"amount": number, "currency": "EUR" | ...,
             "scope": "flights" | "stays" | "total" | null} | null,
  "preferences": {
    "max_stops": 0 | 1 | 2 | null, "avoid_overnight_layover": bool,
    "avoid_self_transfer": bool, "avoid_night_departure": bool
  },
  "profile": "budget" | "balanced" | "time_is_money",
  "assumed": [str], "flags": [str],
  "needs_clarification": bool, "clarifying_question": str | null,
  "confidence": 0.0-1.0
}
- Точну дату вильоту пиши в "departure"; якщо відомий лише період (місяць, «на вихідних»),
  залиш "departure": null і заповни "departure_range".
- "iata" бери ЛИШЕ з результатів lookup_airport. Не знайшов — "iata": null.
- Немає дати повернення — це пошук в один бік, НЕ привід для уточнення.
- Якщо origin взято з context.home_airport, додай у "assumed" рядок "origin=home_airport".
- "conversation" — попередні репліки цього ж запиту (role=assistant — твої уточнюючі
  питання), "user_message" — відповідь на останнє питання. Поєднай усе відоме з розмови
  в ОДИН запит; пізніша репліка має перевагу над ранішою.
"""


class _Lenient(BaseModel):
    """Відповідь моделі: зайві поля ігноруємо, типи перевіряємо."""

    model_config = ConfigDict(extra="ignore")


class PlaceRef(_Lenient):
    raw: str | None = None
    iata: str | None = None
    type: Literal["airport", "city"] | None = None


class DateRange(_Lenient):
    from_: date = Field(alias="from")
    to: date


class ParsedDates(_Lenient):
    departure: date | None = None
    departure_range: DateRange | None = None
    return_: date | None = Field(default=None, alias="return")
    flex_days: int | None = Field(default=None, ge=0, le=MAX_FLEX_DAYS)
    trip_length_days: int | None = Field(default=None, ge=1, le=365)


class ParsedPassengers(_Lenient):
    adults: int = Field(default=1, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    infants: int = Field(default=0, ge=0, le=8)


class Budget(_Lenient):
    amount: Decimal = Field(gt=0)
    currency: str = DEFAULT_CURRENCY
    scope: Literal["flights", "stays", "total"] | None = None

    @field_validator("currency")
    @classmethod
    def _upper(cls, value: str) -> str:
        return value.upper()


class Preferences(_Lenient):
    max_stops: int | None = Field(default=None, ge=0, le=2)
    avoid_overnight_layover: bool = False
    avoid_self_transfer: bool = False
    avoid_night_departure: bool = False


class ParsedRequest(_Lenient):
    """Те, що повернула модель (після перевірки типів)."""

    intent: Literal["flights", "stays", "both", "out_of_scope"] = "flights"
    origin: PlaceRef | None = None
    destination: PlaceRef | None = None
    dates: ParsedDates = ParsedDates()
    passengers: ParsedPassengers = ParsedPassengers()
    budget: Budget | None = None
    preferences: Preferences = Preferences()
    profile: Literal["budget", "balanced", "time_is_money"] = "balanced"
    assumed: list[str] = []
    flags: list[str] = []
    needs_clarification: bool = False
    clarifying_question: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


ParseStatus = Literal["search", "clarify", "unsupported", "unavailable"]
Note = Literal[
    "origin_from_home",
    "date_from_calendar",
    "date_from_range_middle",
    "return_from_trip_length",
    "budget_applied",
    "budget_not_applied",
    "overnight_layover_scored",
    "self_transfer_scored",
    "stays_later",
]


class Turn(BaseModel):
    """Репліка діалогу уточнень. Приходить від клієнта — для моделі це лише дані."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)


class ParseContext(BaseModel):
    today: date
    home_airport: str | None = None
    currency: str = DEFAULT_CURRENCY
    locale: str = "uk"


class ParseResult(BaseModel):
    status: ParseStatus
    query: FlightQuery | None = None
    clarifying_question: str | None = None
    notes: list[Note] = []
    """Що код додав чи не зміг застосувати — UI показує це людською мовою."""
    flags: list[str] = []


class QueryParser:
    def __init__(
        self,
        airports: AirportDirectory,
        *,
        model: str,
        cheapest_day: CheapestDay | None = None,
        prompts_dir: Path | None = None,
    ) -> None:
        self._airports = airports
        self._model = model
        self._cheapest_day = cheapest_day
        self._system = system_prompt("Query-Parser", prompts_dir) + "\n" + OUTPUT_CONTRACT

    @property
    def version(self) -> str:
        """Відбиток моделі й промпту: змінили промпт чи модель — кеш відповідей не підтягнеться."""
        return hashlib.sha256(f"{self._model}\n{self._system}".encode()).hexdigest()[:12]

    async def parse(
        self,
        message: str,
        context: ParseContext,
        llm: LLMClient,
        history: Sequence[Turn] = (),
    ) -> ParseResult:
        """`llm` — обгортка з лімітом викликів (MeteredLLM) на цей запит.

        `history` — попередні репліки, якщо `message` відповідає на уточнююче питання.
        """
        try:
            parsed = await self._ask_model(
                message[:MAX_MESSAGE_LENGTH], context, llm, history[-MAX_HISTORY_TURNS:]
            )
        except LLMError as exc:
            log.warning("ai.parse.llm_failed", error=exc.message)
            return ParseResult(status="unavailable")
        if parsed is None:  # модель відповіла не за контрактом — просимо сформулювати інакше
            return ParseResult(status="clarify")
        return await self._to_result(parsed, context)

    # --- модель -----------------------------------------------------------------

    async def _ask_model(
        self, message: str, context: ParseContext, llm: LLMClient, history: Sequence[Turn]
    ) -> ParsedRequest | None:
        # Текст користувача (і вся розмова) — полями JSON, а не частиною інструкцій.
        payload: dict[str, object] = {
            "user_message": message,
            "context": context.model_dump(mode="json"),
        }
        if history:
            payload["conversation"] = [turn.model_dump() for turn in history]
        messages: list[Message] = [
            Message("system", self._system),
            Message("user", json.dumps(payload, ensure_ascii=False)),
        ]
        # Цикл обмежує MeteredLLM (ліміт викликів на запит): вичерпав — LLMError.
        while True:
            response = await llm.chat(
                ChatRequest(
                    model=self._model,
                    messages=tuple(messages),
                    tools=(LOOKUP_TOOL,),
                    json_output=True,
                    max_tokens=1200,
                    temperature=0,
                )
            )
            if not response.tool_calls:
                return _parse_json(response.content)
            messages.append(Message("assistant", response.content, response.tool_calls))
            for call in response.tool_calls:
                result = self._run_tool(call.name, call.arguments)
                messages.append(Message("tool", result, tool_call_id=call.id))

    def _run_tool(self, name: str, arguments: str) -> str:
        if name != LOOKUP_TOOL.name:
            return json.dumps({"error": f"unknown tool {name}"})
        return lookup_airport(self._airports, arguments)

    # --- перетворення на пошук ----------------------------------------------------

    async def _to_result(self, parsed: ParsedRequest, context: ParseContext) -> ParseResult:
        flags = list(parsed.flags)
        if parsed.intent == "out_of_scope":
            return ParseResult(status="unsupported", flags=flags)
        notes: list[Note] = []
        if parsed.intent == "stays":
            return ParseResult(status="unsupported", notes=["stays_later"], flags=flags)
        if parsed.intent == "both":
            notes.append("stays_later")

        origin = self._resolve(parsed.origin)
        home = context.home_airport
        if origin is None and home and self._airports.knows(home):
            origin = home.upper()
        from_home = parsed.origin is None or "origin=home_airport" in parsed.assumed
        if origin and home and origin == home.upper() and from_home:
            notes.append("origin_from_home")
        destination = self._resolve(parsed.destination)
        departure, dep_note = await self._departure(parsed.dates, origin, destination, context)
        if dep_note:
            notes.append(dep_note)

        # Критичні поля (звідки, куди, коли) перевіряє код. Модель буває надто обережна і
        # питає про необов'язкове (дату повернення) — тоді шукаємо, а не перепитуємо.
        if not (origin and destination and departure):
            return ParseResult(
                status="clarify",
                clarifying_question=parsed.clarifying_question,
                notes=notes,
                flags=flags,
            )

        dates = parsed.dates
        return_date = dates.return_
        if return_date is None and dates.trip_length_days:
            return_date = departure + timedelta(days=dates.trip_length_days)
            notes.append("return_from_trip_length")
        if return_date is not None and return_date < departure:
            return_date = None
        flex = dates.flex_days or 0
        if dates.departure is None and dates.departure_range is not None:
            flex = max(flex, MONTH_ONLY_FLEX_DAYS)

        filters, filter_notes = self._filters(parsed, context)
        notes += filter_notes
        try:
            query = FlightQuery(
                origin=origin,
                destination=destination,
                departure_date=departure,
                return_date=return_date,
                flex_days=min(flex, MAX_FLEX_DAYS),
                # Діти й немовлята — у запит: ціну за весь склад рахує джерело (ADR 0013).
                passengers={
                    "adults": parsed.passengers.adults,
                    "children": parsed.passengers.children,
                    "infants": parsed.passengers.infants,
                },
                direct_only=parsed.preferences.max_stops == 0,
                currency=context.currency,
                profile=parsed.profile,
                filters=filters,
            )
        except ValidationError as exc:
            log.info("ai.parse.invalid_query", errors=exc.error_count())
            return ParseResult(status="clarify", notes=notes, flags=flags)
        return ParseResult(status="search", query=query, notes=notes, flags=flags)

    def _resolve(self, place: PlaceRef | None) -> str | None:
        """Код лише з довідника: спершу те, що дала модель, далі — пошук за назвою."""
        if place is None:
            return None
        if place.iata and self._airports.knows(place.iata):
            return place.iata.upper()
        if place.raw:
            found = self._airports.search(place.raw, limit=1)
            if found:
                return found[0].code
        return None

    async def _departure(
        self,
        dates: ParsedDates,
        origin: str | None,
        destination: str | None,
        context: ParseContext,
    ) -> tuple[date | None, Note | None]:
        if dates.departure is not None:
            return (dates.departure if dates.departure >= context.today else None), None
        window = dates.departure_range
        if window is None or window.to < context.today:
            return None, None
        start, end = max(window.from_, context.today), window.to
        if self._cheapest_day and origin and destination:
            try:
                best = await self._cheapest_day(origin, destination, start, end)
            except Exception:  # календар — підказка, не умова розбору
                log.warning("ai.parse.calendar_failed", exc_info=True)
                best = None
            if best is not None and start <= best <= end:
                return best, "date_from_calendar"
        return start + timedelta(days=(end - start).days // 2), "date_from_range_middle"

    @staticmethod
    def _filters(parsed: ParsedRequest, context: ParseContext) -> tuple[OfferFilters, list[Note]]:
        notes: list[Note] = []
        prefs = parsed.preferences
        max_stops = prefs.max_stops if prefs.max_stops not in (None, 0) else None
        periods: list[DeparturePeriod] = []
        if prefs.avoid_night_departure:
            periods = ["morning", "afternoon", "evening"]
        if prefs.avoid_overnight_layover:
            notes.append("overnight_layover_scored")
        if prefs.avoid_self_transfer:
            notes.append("self_transfer_scored")
        max_price = None
        budget = parsed.budget
        if budget is not None:
            # Фільтр — ціна на пасажира; «на все» (з житлом) чи в іншій валюті не застосовуємо.
            if budget.scope in (None, "flights") and budget.currency == context.currency:
                # Ціле число одиниць валюти, округлення вниз: «до 300 € на двох» → до 150 €.
                travellers = (
                    parsed.passengers.adults
                    + parsed.passengers.children
                    + parsed.passengers.infants
                )
                max_price = int(budget.amount // max(travellers, 1))
                notes.append("budget_applied")
            else:
                notes.append("budget_not_applied")
        return (
            OfferFilters(max_stops=max_stops, departure_periods=periods, max_price=max_price),
            notes,
        )


def lookup_airport(airports: AirportDirectory, arguments: str) -> str:
    """Інструмент LOOKUP_TOOL: аргументи від моделі (JSON-рядок) → відповідь для неї."""
    try:
        query = str(json.loads(arguments)["query"])[:64]
    except (ValueError, KeyError, TypeError):
        return json.dumps({"error": "arguments must be JSON with 'query'"})
    places = airports.search(query, limit=LOOKUP_LIMIT, lang="en")
    return json.dumps(
        [
            {
                "iata": p.code,
                "type": p.kind,
                "name": p.name,
                "city": p.city_name,
                "country": p.country_name,
                "airports": p.airports,
            }
            for p in places
        ],
        ensure_ascii=False,
    )


def _parse_json(content: str) -> ParsedRequest | None:
    try:
        return ParsedRequest.model_validate_json(content)
    except ValidationError as exc:
        log.warning("ai.parse.bad_model_output", errors=exc.error_count())
        return None
