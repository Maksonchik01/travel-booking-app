from datetime import UTC, datetime
from typing import Literal, Self

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from tickets_api.ai.assistant import (
    MAX_CHAT_TURNS,
    MAX_USER_MESSAGE_LENGTH,
    ChatContext,
    ChatMode,
    ChatReply,
    ChatTurn,
)
from tickets_api.ai.explainer import ExplainResult
from tickets_api.ai.parser import (
    MAX_HISTORY_TURNS,
    MAX_MESSAGE_LENGTH,
    ParseContext,
    ParseResult,
    Turn,
)
from tickets_api.ai.service import AIService
from tickets_api.ai.stay_analyst import StayAnalysisResult
from tickets_api.core.rate_limit import concurrent_searches, rate_limit
from tickets_api.domain.flights import DEFAULT_CURRENCY, Currency, FlightQuery, Iata
from tickets_api.domain.locale import DEFAULT_AI_LOCALE, UiLocale
from tickets_api.domain.stays import StayQuery
from tickets_api.domain.trips import TripPreferences, TripQuery

router = APIRouter(prefix="/ai", tags=["ai"])


class AIStatus(BaseModel):
    enabled: bool
    provider: Literal["off", "mock", "deepseek"]


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)
    home_airport: Iata | None = None
    """Що стоїть у полі «Звідки» — якщо в тексті місто вильоту не назване."""
    history: list[Turn] = Field(default=[], max_length=MAX_HISTORY_TURNS)
    """Попередні репліки, якщо `message` — відповідь на уточнююче питання."""


def _service(request: Request) -> AIService:
    service: AIService | None = request.app.state.ai
    if service is None:
        raise HTTPException(status_code=503, detail="AI features are disabled")
    return service


@router.get("/status", response_model=AIStatus)
async def ai_status(request: Request) -> AIStatus:
    service: AIService | None = request.app.state.ai
    if service is None:
        return AIStatus(enabled=False, provider="off")
    provider: Literal["mock", "deepseek"] = "mock" if service.provider == "mock" else "deepseek"
    return AIStatus(enabled=True, provider=provider)


@router.post("/parse", response_model=ParseResult, dependencies=[Depends(rate_limit("ai"))])
async def parse_request(body: ParseRequest, request: Request) -> ParseResult:
    """Текст природною мовою → структурований пошук (або одне уточнююче питання)."""
    service = _service(request)
    context = ParseContext(today=datetime.now(UTC).date(), home_airport=body.home_airport)
    return await service.parse(body.message, context, body.history)


class ChatBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatTurn] = Field(min_length=1, max_length=MAX_CHAT_TURNS)
    """Розмова від початку (чи останні MAX_CHAT_TURNS реплік); остання — від користувача."""
    mode: ChatMode = "flights"
    """Окремі чати: квитки, житло, уся поїздка."""
    current_search: FlightQuery | None = None
    """Пошук перельотів, результати якого відкриті на сторінці (з URL)."""
    current_stay_search: StayQuery | None = None
    """Те саме для житла."""
    current_trip: TripQuery | None = None
    """Поїздка, відкрита в планувальнику (з вибором рейсу й житла) — для команд «змінити»."""
    previous_trip: TripQuery | None = None
    """Попередній крок поїздки з історії вкладки — «поверни», «порівняй з попереднім»."""
    home_airport: Iata | None = None
    currency: Currency = DEFAULT_CURRENCY
    """Валюта профілю (веб підставляє з акаунта)."""
    preferences: TripPreferences | None = None
    """М'які уподобання профілю — лише в оцінку пошуків помічника."""
    locale: UiLocale = DEFAULT_AI_LOCALE
    """Мова інтерфейсу — нею відповідає помічник."""

    @model_validator(mode="after")
    def _last_is_user(self) -> Self:
        last = self.messages[-1]
        if last.role != "user":
            raise ValueError("the last message must be from the user")
        if len(last.text) > MAX_USER_MESSAGE_LENGTH:
            raise ValueError(f"the message is longer than {MAX_USER_MESSAGE_LENGTH} characters")
        return self


@router.post(
    "/chat",
    response_model=ChatReply,
    dependencies=[Depends(rate_limit("ai")), Depends(concurrent_searches)],
)
async def chat(body: ChatBody, request: Request) -> ChatReply:
    """Репліка розмови з агентом. Сервер розмову не зберігає — її надсилає клієнт."""
    service = _service(request)
    context = ChatContext(
        today=datetime.now(UTC).date(),
        home_airport=body.home_airport,
        current_search=body.current_search,
        current_stay_search=body.current_stay_search,
        current_trip=body.current_trip,
        previous_trip=body.previous_trip,
        currency=body.currency,
        preferences=body.preferences,
        locale=body.locale,
    )
    return await service.chat(body.messages, context, body.mode)


class StayAnalysisBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: StayQuery
    stay_keys: list[str] = Field(min_length=1, max_length=3)
    """`source:id` об'єктів з результатів пошуку — не більше трьох за раз."""
    locale: UiLocale = DEFAULT_AI_LOCALE


@router.post(
    "/stays/analysis", response_model=StayAnalysisResult, dependencies=[Depends(rate_limit("ai"))]
)
async def analyze_stays(body: StayAnalysisBody, request: Request) -> StayAnalysisResult:
    """Резюме відгуків і порівняння вибраних об'єктів. Value-score — з коду, не з моделі."""
    return await _service(request).analyze_stays(body.query, body.stay_keys, body.locale)


@router.post("/explain", response_model=ExplainResult, dependencies=[Depends(rate_limit("ai"))])
async def explain_results(
    query: FlightQuery, request: Request, locale: UiLocale = DEFAULT_AI_LOCALE
) -> ExplainResult:
    """Пояснення найкращих варіантів пошуку мовою інтерфейсу. Числа — лише з результатів
    скорингу."""
    return await _service(request).explain(query, locale)
