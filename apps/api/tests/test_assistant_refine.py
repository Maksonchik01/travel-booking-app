"""Модуль 9a: уточнення поточного пошуку змінює лише назване; команди готової поїздки
змінюють реальний стан (запит з вибором), а вибір рейсу й житла робить код."""

from datetime import date
from decimal import Decimal

import pytest
from test_assistant import CONTEXT, NOW, Scripted, assistant, text, tool, tool_outputs, turns
from tickets_api.ai.assistant import ChatContext, ChatReply, ChatTurn, TravelAssistant
from tickets_api.ai.refine import (
    FlightRefinement,
    RefineError,
    StayRefinement,
    TripChange,
    refine_flights,
    refine_stays,
    refine_trip,
)
from tickets_api.domain.flights import FlightQuery
from tickets_api.domain.stays import StayQuery
from tickets_api.domain.trips import TripQuery

FLIGHT = FlightQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 5),
    return_date=date(2026, 12, 8),
    passengers={"adults": 2},
    origin_radius_km=150,
)
TRIP = TripQuery(
    origin="WAW",
    destination="LIS",
    departure_date=date(2026, 12, 5),
    return_date=date(2026, 12, 8),
)


def test_refinements_accumulate_and_keep_everything_else() -> None:
    direct = refine_flights(FLIGHT, FlightRefinement(direct_only=True))
    evening = refine_flights(direct, FlightRefinement(departure_after=18))
    budget = refine_flights(evening, FlightRefinement(max_price=600))
    more = refine_flights(budget, FlightRefinement(max_price_change=100))

    assert more.direct_only
    assert more.filters.departure_hours is not None
    assert (more.filters.departure_hours.start, more.filters.departure_hours.end) == (18, 24)
    assert more.filters.max_price == 700  # +100 рахує код
    # Решта — без змін: дати, пасажири, сусідні аеропорти.
    assert (more.departure_date, more.return_date) == (FLIGHT.departure_date, FLIGHT.return_date)
    assert more.passengers.adults == 2
    assert more.origin_radius_km == 150
    cleared = refine_flights(more, FlightRefinement(clear=["times", "price"]))
    assert cleared.filters.departure_hours is None
    assert cleared.filters.max_price is None
    assert cleared.direct_only
    with pytest.raises(RefineError):
        refine_flights(FLIGHT, FlightRefinement(max_price_change=50))  # немає від чого рахувати


def test_stay_and_trip_refinements() -> None:
    stay = StayQuery(city="LIS", check_in=date(2026, 12, 5), check_out=date(2026, 12, 8))
    closer = refine_stays(stay, StayRefinement(max_distance_km=2, min_rating=8))
    assert closer.filters.max_distance_center_km == 2
    assert closer.filters.min_rating == 8
    assert closer.check_in == stay.check_in

    budget = refine_trip(
        TRIP.model_copy(update={"budget_total": 500}), TripChange(budget_change=100)
    )
    assert budget.budget_total == 600
    with pytest.raises(RefineError):
        refine_trip(TRIP, TripChange(budget_change=100))
    pinned = TRIP.model_copy(update={"flight": "mock:abc", "stay": "mock:mock-lis-1"})
    moved = refine_trip(pinned, TripChange(departure_date=date(2026, 12, 6)))
    assert moved.flight is None  # інші дати — інші рейси
    assert moved.stay == "mock:mock-lis-1"  # житло перевірить планувальник


async def test_chat_refine_flights_changes_only_what_was_asked() -> None:
    agent, _ = assistant()
    current = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))
    client = Scripted(
        tool("refine_flights", direct_only=True, departure_after=18),
        text("Готово."),
    )
    context = CONTEXT.model_copy(update={"current_search": current})

    reply = await agent.reply(turns("лише прямі після 18:00"), context, client)

    assert reply.search is not None
    assert reply.search.direct_only
    assert reply.search.filters.departure_hours is not None
    assert reply.search.departure_date == current.departure_date
    [result] = tool_outputs(client)
    assert result["active_filters"]["departure_hours"] == {"start": 18, "end": 24}


async def test_refine_without_current_search_asks_model_to_search() -> None:
    agent, _ = assistant()
    client = Scripted(tool("refine_flights", direct_only=True), text("Куди летимо?"))

    reply = await agent.reply(turns("лише прямі"), CONTEXT, client)

    assert reply.search is None
    [result] = tool_outputs(client)
    assert "no current flight search" in result["error"]


async def trip_reply(
    agent: TravelAssistant, conversation: list[ChatTurn], context: ChatContext, client: Scripted
) -> ChatReply:
    return await agent.reply(conversation, context, client, mode="trip")


async def test_change_trip_keeps_flight_and_picks_cheaper_stay_by_code() -> None:
    agent, _ = assistant()
    context = ChatContext(today=date(2026, 11, 4), current_trip=TRIP)
    client = Scripted(tool("change_trip", flight="keep", stay="cheaper"), text("Готово."))

    reply = await trip_reply(
        agent, turns("знайди дешевший готель, авіаквитки не змінюй"), context, client
    )

    [result] = tool_outputs(client)
    trip = reply.trip_search
    assert trip is not None
    assert trip.flight is not None
    assert trip.stay is not None
    if result["stay_changed"]:
        assert result["difference_text"].startswith("-")
        assert not result["flight_changed"]  # «не змінюй авіаквитки»
    else:
        assert result["no_better_option_found"] == ["stay"]


async def test_trip_undo_compare_and_save_produce_ui_effects() -> None:
    agent, _ = assistant()
    previous = TRIP
    current = TRIP.model_copy(update={"budget_total": 900, "profile": "comfort"})
    context = ChatContext(today=date(2026, 11, 4), current_trip=current, previous_trip=previous)

    undo = await trip_reply(
        agent, turns("поверни попередній"), context, Scripted(tool("undo_trip"), text("Повернув."))
    )
    assert undo.trip_action == "undo"

    client = Scripted(tool("compare_trips", first="current", second="cheapest"), text("Ось."))
    compared = await trip_reply(agent, turns("порівняй з найдешевшою"), context, client)
    assert len(compared.compare) == 2
    assert compared.compare[0].title == "Поточна поїздка"
    [result] = tool_outputs(client)
    assert "second_minus_first_text" in result

    saved = await trip_reply(
        agent, turns("збережи цей варіант"), context, Scripted(tool("save_trip"), text("Зберіг."))
    )
    body = saved.save_trip
    assert body is not None
    assert body.query.flight is not None
    assert body.query.stay is not None
    assert body.snapshot.money_total > Decimal(0)
    assert body.snapshot.priced_at == NOW
    no_previous = await trip_reply(
        agent,
        turns("поверни"),
        ChatContext(today=date(2026, 11, 4), current_trip=current),
        Scripted(tool("undo_trip"), text("Немає попереднього.")),
    )
    assert no_previous.trip_action is None


async def test_plan_trip_with_flexible_month_and_wishes() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool(
            "plan_trip",
            origin="WAW",
            destination="LIS",
            departure_date="2026-12-01",
            departure_until="2026-12-20",
            min_nights=3,
            budget_total=500,
            stay_min_rating=8,
            stay_max_distance_km=3,
        ),
        text("Ось варіанти."),
    )

    reply = await trip_reply(
        agent, turns("4 дні в грудні, бюджет 500, хороший готель у центрі"), CONTEXT, client
    )

    trip = reply.trip_search
    assert trip is not None
    assert (trip.min_nights, trip.max_nights) == (3, 3)
    assert trip.return_date is None
    assert trip.departure_until == date(2026, 12, 20)
    assert trip.stay_filters.min_rating == 8
    assert trip.budget_total == 500


async def test_cards_come_from_tool_results_not_the_model() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool("search_flights", origin="WAW", destination="LIS", departure_date="2026-11-10"),
        text("Ось варіанти."),
    )

    reply = await agent.reply(turns("WAW → LIS 10 листопада"), CONTEXT, client)

    [result] = tool_outputs(client)
    assert reply.cards
    assert len(reply.cards) <= 3
    card = reply.cards[0]
    assert card.kind == "flight"
    prices = {o["price_text"] for o in result["options"]}
    assert any(f"{card.price:.0f}" in p for p in prices)  # ціна картки — з тих самих результатів
    assert card.price_status in {"live", "cached"}
    assert card.found_at is not None


async def test_trip_cards_open_the_exact_combination_in_the_planner() -> None:
    agent, _ = assistant()
    client = Scripted(
        tool(
            "plan_trip",
            origin="WAW",
            destination="LIS",
            departure_date="2026-12-05",
            return_date="2026-12-08",
        ),
        text("Ось поїздки."),
    )

    reply = await trip_reply(agent, turns("Варшава — Лісабон 5–8 грудня"), CONTEXT, client)

    assert reply.cards
    labels = {c.label for c in reply.cards}
    assert labels <= {"Економ", "Оптимальний", "Комфорт"}
    for card in reply.cards:
        assert card.kind == "trip"
        assert card.query.flight == card.flight.key
        assert card.query.stay == card.stay.key
        assert card.query.origin == "WAW"
        assert card.nights == 3
