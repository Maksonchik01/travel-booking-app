"""ШІ-помічник і Explore (етап 8, ADR 0052): «куди з Амстердама за 100 €», «на двох до 500 €»,
«в Європу на вихідні», «порівняй Рим і Барселону» — справжній пошук напрямків, числа — від коду."""

import json
from datetime import UTC, date, datetime
from typing import Any

from test_assistant import Scripted, text, tool, tool_outputs, turns
from tickets_api.ai.assistant import ChatContext, TravelAssistant
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.reference.destinations import default_destination_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.explore import ExploreService
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner

NOW = datetime(2026, 11, 4, 12, tzinfo=UTC)
CONTEXT = ChatContext(today=date(2026, 11, 4))


def agent() -> TravelAssistant:
    airports = default_airport_directory()
    flights = FlightSearchService(
        [MockFlightProvider(clock=lambda: NOW)],
        timeout_s=5,
        scoring_config=default_scoring_config(),
    )
    stays = StaySearchService(
        [MockStayProvider(airports, clock=lambda: NOW)],
        airports=airports,
        timeout_s=5,
        scoring_config=default_stay_scoring_config(),
    )
    explore = ExploreService(
        flights, stays, airports=airports, destinations=default_destination_directory()
    )
    return TravelAssistant(
        airports,
        flights,
        model="m",
        stay_search=stays,
        trip_planner=TripPlanner(flights, stays),
        explore=explore,
        clock=lambda: NOW,
    )


def explore(**arguments: Any) -> Any:
    return tool("explore_destinations", **arguments)


async def test_where_to_fly_on_budget_gives_destinations_cards_and_explore_link() -> None:
    client = Scripted(
        explore(origin="AMS", departure_date="2026-12-01", budget=400),
        text("Ось куди можна полетіти — ціни нижче."),
    )

    reply = await agent().reply(turns("Куди полетіти з Амстердама за 400 €?"), CONTEXT, client)

    assert reply.status == "ok"
    output = tool_outputs(client)[0]
    assert output["found"] > 0
    assert output["destinations"][0]["flight_price_text"].endswith("EUR")
    assert reply.explore_search is not None
    assert reply.explore_search.origins == ["AMS"]
    assert reply.explore_search.budget == 400
    # Без явного періоду — місяць від дати вильоту, без житла.
    assert reply.explore_search.departure_until == date(2026, 12, 31)
    assert reply.explore_search.mode == "flights"
    assert reply.cards
    assert all(card.kind == "destination" for card in reply.cards)


async def test_europe_weekends_and_trip_for_two_with_budget() -> None:
    client = Scripted(
        explore(
            origin="WAW",
            region="europe",
            departure_date="2026-12-01",
            weekends=True,
            adults=2,
            budget=900,
            with_stay=True,
        ),
        text("Вихідні в Європі на двох — варіанти нижче."),
    )

    reply = await agent().reply(
        turns("Хочу в Європу на вихідні, нас двоє, до 900 €"), CONTEXT, client, "trip"
    )

    query = reply.explore_search
    assert query is not None
    assert (query.region, query.weekends, query.adults, query.mode) == ("europe", True, 2, "trip")
    output = tool_outputs(client)[0]
    assert output["stays_checked"] == 3
    priced = [d for d in output["destinations"] if "total_text" in d]
    assert priced  # загальна сума — від коду, не від моделі


async def test_compare_two_named_cities() -> None:
    client = Scripted(
        explore(origin="WAW", cities=["ROM", "BCN"], departure_date="2026-12-01"),
        text("Рим і Барселона — поруч нижче."),
    )

    reply = await agent().reply(turns("Порівняй Рим і Барселону"), CONTEXT, client)

    output = tool_outputs(client)[0]
    assert {d["code"] for d in output["destinations"]} <= {"ROM", "BCN"}
    assert {d["code"] for d in output["destinations"]} | set(output["not_found"]) == {"ROM", "BCN"}
    assert reply.cards


async def test_invented_total_is_rejected_and_past_date_goes_back() -> None:
    client = Scripted(
        explore(origin="AMS", departure_date="2026-10-01"),
        explore(origin="AMS", departure_date="2026-12-01"),
        text("Знайшов Ліссабон за 4321 EUR."),
        text("Ось варіанти — дивіться картки."),
    )

    reply = await agent().reply(turns("Куди з Амстердама?"), CONTEXT, client)

    first = json.loads(client.requests[1].messages[-1].content)
    assert "past" in first["error"]
    assert reply.status == "ok"
    assert reply.reply == "Ось варіанти — дивіться картки."
