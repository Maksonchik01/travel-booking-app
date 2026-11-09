import json
from datetime import UTC, date, datetime
from typing import Any

from flight_fakes import StubProvider, day, offers_for
from tickets_api.ai.assistant import (
    MAX_SEARCHES_PER_TURN,
    ChatContext,
    ChatTurn,
    TravelAssistant,
)
from tickets_api.domain.flights import FlightPreferences, FlightQuery
from tickets_api.domain.trips import TripPreferences
from tickets_api.llm.types import ChatRequest, ChatResponse, LLMError, ToolCall
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner

TODAY = date(2026, 11, 4)
NOW = datetime(2026, 11, 4, 12, tzinfo=UTC)
CONTEXT = ChatContext(today=TODAY)


class Scripted:
    """Модель за сценарієм: віддає відповіді по черзі й запам'ятовує запити."""

    name = "scripted"

    def __init__(self, *responses: ChatResponse) -> None:
        self._responses = list(responses)
        self.requests: list[ChatRequest] = []

    async def chat(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        return self._responses.pop(0)


def tool(name: str, **arguments: Any) -> ChatResponse:
    call = ToolCall(id=f"c-{name}", name=name, arguments=json.dumps(arguments))
    return ChatResponse(model="m", content="", tool_calls=(call,))


def text(content: str) -> ChatResponse:
    return ChatResponse(model="m", content=content)


def assistant(provider: StubProvider | None = None) -> tuple[TravelAssistant, StubProvider]:
    provider = provider or StubProvider("a", offers=offers_for("a", [88, 152]))
    search = FlightSearchService([provider], timeout_s=1, scoring_config=default_scoring_config())
    # Поїздка — туди-назад: mock-провайдер перельотів дає зворотні рейси.
    trip_flights = FlightSearchService(
        [MockFlightProvider(clock=lambda: NOW)],
        timeout_s=1,
        scoring_config=default_scoring_config(),
    )
    stays = StaySearchService(
        [MockStayProvider(default_airport_directory(), clock=lambda: NOW)],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
    )
    agent = TravelAssistant(
        default_airport_directory(),
        search,
        model="deepseek-flash",
        stay_search=stays,
        trip_planner=TripPlanner(trip_flights, stays),
        clock=lambda: NOW,
    )
    return agent, provider


def turns(*texts: str) -> list[ChatTurn]:
    """Чергування user/assistant, починаючи з користувача."""
    return [
        ChatTurn(role="user" if i % 2 == 0 else "assistant", text=t) for i, t in enumerate(texts)
    ]


def tool_outputs(client: Scripted) -> list[dict[str, Any]]:
    last = client.requests[-1]
    return [json.loads(m.content) for m in last.messages if m.role == "tool"]


async def test_answer_after_question_uses_whole_conversation() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        text("Радимо Збалансований: 88 EUR, прямий, ціна отримана 9 дн тому."),
    )
    conversation = turns("Хочу в Лісабон", "Звідки і коли летите?", "з Варшави 10 листопада")

    reply = await agent.reply(conversation, CONTEXT, client)

    assert reply.status == "ok"
    assert reply.reply is not None
    assert "88 EUR" in reply.reply
    assert reply.search == FlightQuery(
        origin="WAW", destination="LIS", departure_date=date(2026, 11, 10)
    )
    roles = [m.role for m in client.requests[0].messages]
    assert roles == ["system", "user", "assistant", "user"]
    [result] = tool_outputs(client)
    assert result["recommended_by_scoring"] == "balanced"
    assert "score_breakdown" not in result["options"][0]


async def test_follow_up_changes_current_search_and_keeps_nearby_airports() -> None:
    agent, _ = assistant()
    current = FlightQuery(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 11, 10),
        origin_radius_km=150,
    )
    client = Scripted(
        tool(
            "search_flights",
            origin="WAW",
            destination="LIS",
            departure_date="2026-11-10",
            direct_only=True,
        ),
        text("Прямих 2 варіанти, найдешевший — 88 EUR."),
    )

    reply = await agent.reply(
        turns("WAW LIS 10.11", "Ось варіанти.", "а прямі?"),
        ChatContext(today=TODAY, current_search=current),
        client,
    )

    assert reply.search is not None
    assert reply.search.direct_only is True
    assert reply.search.origin_radius_km == 150
    system = client.requests[0].messages[0].content
    assert '"origin_radius_km":150' in system  # поточний пошук — у контексті моделі


async def test_invented_number_gets_one_retry() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        text("Найдешевший коштує 77 EUR."),
        text("Найдешевший коштує 88 EUR."),
    )

    reply = await agent.reply(turns("Варшава Лісабон 10 листопада"), CONTEXT, client)

    assert (reply.status, reply.reply) == ("ok", "Найдешевший коштує 88 EUR.")
    feedback = client.requests[-1].messages[-1]
    assert feedback.role == "user"
    assert "77" in feedback.content


async def test_invented_twice_is_fallback_but_keeps_search() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        text("Лише 49 EUR!"),
        text("Лише 59 EUR!"),
    )

    reply = await agent.reply(turns("Варшава Лісабон 10 листопада"), CONTEXT, client)

    assert reply.status == "fallback"
    assert reply.reply is None
    assert reply.search is not None


async def test_unknown_code_and_past_date_go_back_to_model() -> None:
    agent, provider = assistant()
    client = Scripted(
        tool("search_flights", origin="QQQ", destination="LIS", departure_date="2026-11-10"),
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-10-01"),
        text("Уточніть дату, будь ласка."),
    )

    reply = await agent.reply(turns("Лісабон"), CONTEXT, client)

    assert reply.status == "ok"
    assert reply.search is None
    assert provider.calls == 0
    unknown, past = tool_outputs(client)
    assert "lookup_airport" in unknown["error"]
    assert "past" in past["error"]


async def test_live_searches_per_reply_are_limited() -> None:
    agent, provider = assistant()
    searches = [
        tool("search_flights", origin="WAW", destination="LIS", departure_date=f"2026-11-{d}")
        for d in (10, 11, 12)
    ]
    client = Scripted(*searches, text("Ось що знайшов."))

    await agent.reply(turns("Лісабон 10, 11 чи 12 листопада"), CONTEXT, client)

    assert provider.calls == MAX_SEARCHES_PER_TURN
    assert "limit" in tool_outputs(client)[-1]["error"]


async def test_calendar_lists_cheapest_future_days() -> None:
    days = [day("a", 2, 30), day("a", 12, 60), day("a", 8, 45), day("a", 20, 40)]
    agent, _ = assistant(StubProvider("a", days=days))
    client = Scripted(
        tool("price_calendar", origin="WAW", destination="LIS", month="2026-11"),
        text("Найдешевше 20 листопада — 40 EUR, орієнтовно."),
    )

    reply = await agent.reply(turns("коли дешевше в листопаді до Лісабона?"), CONTEXT, client)

    assert reply.status == "ok"
    [calendar] = tool_outputs(client)
    # 2 листопада вже минуло.
    assert [d["date"] for d in calendar["cheapest_days"]] == [
        "2026-11-08",
        "2026-11-12",
        "2026-11-20",
    ]
    assert calendar["cheapest_days"][0]["price_text"] == "45 EUR"


async def test_model_failure_is_unavailable() -> None:
    class Down:
        name = "down"

        async def chat(self, request: Any) -> ChatResponse:
            raise LLMError("down", "server overloaded (HTTP 503)", retryable=True)

    agent, _ = assistant()

    reply = await agent.reply(turns("Лісабон"), CONTEXT, Down())

    assert reply.status == "unavailable"


async def test_stays_chat_has_only_stay_tools() -> None:
    agent, provider = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        tool("search_stays", city="LIS", check_in="2026-12-05", check_out="2026-12-08"),
        text("Радимо Збалансований варіант."),
    )

    reply = await agent.reply(turns("Житло в Лісабоні 5–8 грудня"), CONTEXT, client, "stays")

    assert {t.name for t in client.requests[0].tools} == {
        "lookup_airport",
        "search_stays",
        "refine_stays",
    }
    assert "Stay-Assistant" in client.requests[0].messages[0].content
    unknown, stays = tool_outputs(client)
    assert "unknown tool" in unknown["error"]  # квитки — в іншому чаті
    assert provider.calls == 0
    assert reply.search is None
    assert reply.stay_search is not None
    assert reply.stay_search.nights == 3
    assert stays["recommended_by_scoring"] in {o["id"] for o in stays["options"]}
    assert stays["options"][0]["price_per_night_text"].endswith("EUR")


async def test_trip_chat_plans_whole_trip_with_totals_from_code() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool(
            "plan_trip",
            origin="WAW",
            destination="LIS",
            departure_date="2026-12-05",
            return_date="2026-12-08",
        ),
        text("Найвигідніша поїздка — сума нижче."),
    )

    reply = await agent.reply(turns("Поїздка Варшава–Лісабон 5–8 грудня"), CONTEXT, client, "trip")

    assert reply.status == "ok"
    assert {t.name for t in client.requests[0].tools} == {
        "lookup_airport",
        "plan_trip",
        "change_trip",
        "undo_trip",
        "compare_trips",
        "save_trip",
    }
    assert reply.trip_search is not None
    assert (reply.trip_search.origin, reply.trip_search.destination) == ("WAW", "LIS")
    [trip] = tool_outputs(client)
    best = next(o for o in trip["options"] if o["id"] == trip["recommended_by_scoring"])
    assert best["money_total_text"].endswith("EUR")
    assert "житло" in best["breakdown_text"]


async def test_profile_currency_and_preferences_reach_assistant_searches() -> None:
    # Модуль 15: налаштування кабінету діють і в помічнику — валюта й м'які уподобання.
    agent, provider = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        text("Знайшла варіанти."),
    )
    prefs = TripPreferences(flights=FlightPreferences(airlines=["LO"]))
    context = ChatContext(today=TODAY, currency="PLN", preferences=prefs)

    reply = await agent.reply(turns("Варшава — Лісабон 10 листопада"), context, client)

    assert reply.search is not None
    assert reply.search.currency == "PLN"
    assert reply.search.preferences == prefs.flights
    assert provider.queries[-1].currency == "PLN"


async def test_preferences_are_not_sent_to_the_model() -> None:
    agent, _ = assistant()
    client = Scripted(text("Куди летимо?"))
    prefs = TripPreferences(flights=FlightPreferences(airlines=["LO"]))

    await agent.reply(turns("Привіт"), ChatContext(today=TODAY, preferences=prefs), client)

    system = client.requests[0].messages[0].content
    assert "preferences" not in system
    assert '"currency":"EUR"' in system
