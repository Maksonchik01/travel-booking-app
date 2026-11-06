import json
from datetime import date
from typing import Any

import pytest
from tickets_api.ai.evaluation import (
    RECORDED_DIR,
    ReplayClient,
    check,
    load_cases,
    load_responses,
    stub_cheapest_day,
)
from tickets_api.ai.parser import ParseContext, QueryParser, Turn
from tickets_api.llm.types import ChatResponse, LLMError, ToolCall
from tickets_api.reference.airports import default_airport_directory

CASES, KNOWN_FAILURES = load_cases()
CONTEXT = ParseContext(today=date(2026, 11, 4), home_airport="WAW")


def parser(cheapest_day: Any = stub_cheapest_day) -> QueryParser:
    return QueryParser(
        default_airport_directory(), model="deepseek-flash", cheapest_day=cheapest_day
    )


def answer(**fields: Any) -> ChatResponse:
    """Фінальна відповідь моделі з типовими полями + підміна потрібних."""
    body: dict[str, Any] = {
        "intent": "flights",
        "origin": {"raw": "Варшава", "iata": "WAW", "type": "airport"},
        "destination": {"raw": "Лісабон", "iata": "LIS", "type": "airport"},
        "dates": {"departure": "2026-12-05"},
        "passengers": {"adults": 1},
        "profile": "balanced",
    }
    body.update(fields)
    return ChatResponse(model="m", content=json.dumps(body, ensure_ascii=False))


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
async def test_recorded_eval_case(case: Any) -> None:
    """30 тестових запитів на ЗАПИСАНИХ відповідях моделі (scripts/eval_parser.py --record)."""
    path = RECORDED_DIR / f"{case.id}.json"
    responses = load_responses(json.loads(path.read_text()))

    result = await parser().parse(case.message, case.context, ReplayClient(responses))

    errors = check(result, case.expected)
    if case.id in KNOWN_FAILURES:
        pytest.xfail("; ".join(errors) or "known failure fixed — remove from known_failures")
    assert errors == []


async def test_lookup_tool_answers_from_directory() -> None:
    call = ToolCall(id="c1", name="lookup_airport", arguments='{"query": "Lisbon"}')
    client = ReplayClient([ChatResponse(model="m", content="", tool_calls=(call,)), answer()])
    seen: list[str] = []
    original = client.chat

    async def spy(request: Any) -> ChatResponse:
        seen.extend(m.content for m in request.messages if m.role == "tool")
        return await original(request)

    client.chat = spy  # type: ignore[method-assign]

    result = await parser().parse("Лісабон 5 грудня", CONTEXT, client)

    assert result.status == "search"
    [tool_result] = seen
    assert json.loads(tool_result)[0]["iata"] == "LIS"


async def test_unknown_iata_from_model_is_not_trusted() -> None:
    # Модель «згадала» неіснуючий код — беремо код за назвою з довідника.
    model = answer(destination={"raw": "Лісабон", "iata": "QQQ", "type": "airport"})

    result = await parser().parse("...", CONTEXT, ReplayClient([model]))

    assert result.query is not None
    assert result.query.destination == "LIS"


async def test_month_only_uses_cheapest_calendar_day() -> None:
    async def cheapest(origin: str, destination: str, start: date, end: date) -> date:
        assert (origin, destination, start, end) == (
            "WAW",
            "LIS",
            date(2026, 12, 1),
            date(2026, 12, 31),
        )
        return date(2026, 12, 9)

    model = answer(
        dates={"departure_range": {"from": "2026-12-01", "to": "2026-12-31"}, "trip_length_days": 7}
    )

    result = await parser(cheapest).parse("...", CONTEXT, ReplayClient([model]))

    assert result.query is not None
    q = result.query
    assert (q.departure_date, q.return_date, q.flex_days) == (
        date(2026, 12, 9),
        date(2026, 12, 16),
        3,
    )
    assert {"date_from_calendar", "return_from_trip_length"} <= set(result.notes)


async def test_budget_is_per_adult_and_only_in_search_currency() -> None:
    eur = answer(
        budget={"amount": 600, "currency": "eur", "scope": "flights"}, passengers={"adults": 2}
    )
    usd = answer(budget={"amount": 600, "currency": "USD"})
    total = answer(budget={"amount": 600, "currency": "EUR", "scope": "total"})

    r_eur = await parser().parse("...", CONTEXT, ReplayClient([eur]))
    r_usd = await parser().parse("...", CONTEXT, ReplayClient([usd]))
    r_total = await parser().parse("...", CONTEXT, ReplayClient([total]))

    assert r_eur.query is not None
    assert r_eur.query.filters.max_price == 300
    assert r_usd.query is not None
    assert r_usd.query.filters.max_price is None
    assert "budget_not_applied" in r_usd.notes
    assert r_total.query is not None
    assert r_total.query.filters.max_price is None


async def test_preferences_become_filters() -> None:
    model = answer(
        preferences={"max_stops": 0, "avoid_night_departure": True, "avoid_overnight_layover": True}
    )

    result = await parser().parse("...", CONTEXT, ReplayClient([model]))

    assert result.query is not None
    assert result.query.direct_only is True
    assert result.query.filters.departure_periods == ["morning", "afternoon", "evening"]
    assert "overnight_layover_scored" in result.notes


async def test_garbage_from_model_asks_to_rephrase() -> None:
    result = await parser().parse(
        "...", CONTEXT, ReplayClient([ChatResponse(model="m", content="не JSON")])
    )

    assert (result.status, result.query) == ("clarify", None)


async def test_llm_failure_is_unavailable_not_500() -> None:
    class Down:
        name = "down"

        async def chat(self, request: Any) -> ChatResponse:
            raise LLMError("down", "server overloaded (HTTP 503)", retryable=True)

    result = await parser().parse("...", CONTEXT, Down())

    assert result.status == "unavailable"


async def test_answer_to_clarification_carries_conversation() -> None:
    client = ReplayClient([answer()])
    sent: list[dict[str, Any]] = []
    original = client.chat

    async def spy(request: Any) -> ChatResponse:
        sent.append(json.loads(request.messages[-1].content))
        return await original(request)

    client.chat = spy  # type: ignore[method-assign]
    history = [
        Turn(role="user", text="Хочу в Лісабон"),
        Turn(role="assistant", text="Коли плануєте виліт?"),
    ]

    result = await parser().parse("5 грудня", CONTEXT, client, history)

    assert result.status == "search"
    assert sent[0]["user_message"] == "5 грудня"
    assert sent[0]["conversation"] == [
        {"role": "user", "text": "Хочу в Лісабон"},
        {"role": "assistant", "text": "Коли плануєте виліт?"},
    ]


async def test_first_message_has_no_conversation_field() -> None:
    client = ReplayClient([answer()])
    sent: list[dict[str, Any]] = []
    original = client.chat

    async def spy(request: Any) -> ChatResponse:
        sent.append(json.loads(request.messages[-1].content))
        return await original(request)

    client.chat = spy  # type: ignore[method-assign]

    await parser().parse("Лісабон 5 грудня", CONTEXT, client)

    assert "conversation" not in sent[0]


async def test_long_message_is_truncated() -> None:
    client = ReplayClient([answer()])
    sent: list[str] = []
    original = client.chat

    async def spy(request: Any) -> ChatResponse:
        sent.append(request.messages[-1].content)
        return await original(request)

    client.chat = spy  # type: ignore[method-assign]

    await parser().parse("а" * 5000, CONTEXT, client)

    assert len(json.loads(sent[0])["user_message"]) == 500
