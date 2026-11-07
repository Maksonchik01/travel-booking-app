"""Кінцева вартість з багажем і правило «найдешевшого» (модуль 1b, ADR 0014)."""

from decimal import Decimal

import pytest
from flight_fakes import offers_for
from tickets_api.domain.flights import BagAllowance, Baggage, BaggageNeed, Offer, Passengers
from tickets_api.scoring.baggage import baggage_cost
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.engine import offer_key, score_offers

INCLUDED = BagAllowance(status="included")
LOW_COST = Baggage(
    personal_item=INCLUDED,
    carry_on=BagAllowance(status="fee", fee=Decimal(25)),
    checked=BagAllowance(status="fee", fee=Decimal(35)),
    checked_extra=BagAllowance(status="not_available"),
)
FULL = Baggage(personal_item=INCLUDED, carry_on=INCLUDED, checked=INCLUDED)


def with_bags(offer: Offer, baggage: Baggage | None) -> Offer:
    return offer.model_copy(update={"baggage": baggage})


def test_fee_is_paid_for_everyone_with_a_seat() -> None:
    offer = with_bags(offers_for("a", [300])[0], LOW_COST)
    # 2 дорослих + дитина + немовля на руках: багаж — за трьох (у немовляти на руках норми немає).
    family = Passengers(adults=2, children=1, infants=1)

    cost = baggage_cost(offer, "carry_on", family)

    assert (cost.status, cost.extra, cost.total) == ("extra", Decimal(75), Decimal(375))


@pytest.mark.parametrize(
    ("need", "status", "unknown"),
    [
        ("none", "included", []),
        ("personal_item", "included", []),
        ("checked", "included", []),
        ("checked_extra", "unknown", ["checked_extra"]),  # у FULL друга валіза не вказана
    ],
)
def test_statuses(need: BaggageNeed, status: str, unknown: list[str]) -> None:
    cost = baggage_cost(with_bags(offers_for("a", [300])[0], FULL), need, Passengers())
    assert (cost.status, cost.unknown) == (status, unknown)


def test_unknown_conditions_are_not_free() -> None:
    cost = baggage_cost(offers_for("a", [300])[0], "carry_on", Passengers())
    assert (cost.status, cost.total) == ("unknown", None)
    assert cost.unknown == ["personal_item", "carry_on"]


def test_fee_without_amount_and_not_available() -> None:
    no_amount = Baggage(personal_item=INCLUDED, checked=BagAllowance(status="fee"))
    offer = offers_for("a", [300])[0]
    assert baggage_cost(with_bags(offer, no_amount), "checked", Passengers()).status == "unknown"
    assert baggage_cost(with_bags(offer, LOW_COST), "checked_extra", Passengers()).status == (
        "not_available"
    )


def test_cheapest_must_have_known_final_price_when_others_do() -> None:
    cheap_unknown, low_cost, full = offers_for("a", [90, 100, 150])
    offers = [
        with_bags(cheap_unknown, None),  # квиток найдешевший, але багаж невідомий
        with_bags(low_cost, LOW_COST),  # 100 + 35 = 135
        with_bags(full, FULL),  # 150 + 0 = 150
    ]
    costs = {offer_key(o): baggage_cost(o, "checked", Passengers()) for o in offers}

    result = score_offers(offers, "balanced", default_scoring_config(), baggage=costs)

    cheapest = next(p for p in result.picks if p.label == "cheapest" or "cheapest" in p.also)
    assert cheapest.offer_key == offer_key(offers[1])
    assert result.cheapest_basis == "with_baggage"


def test_without_known_totals_cheapest_is_by_ticket() -> None:
    offers = offers_for("a", [90, 100])
    costs = {offer_key(o): baggage_cost(o, "checked", Passengers()) for o in offers}

    result = score_offers(offers, "balanced", default_scoring_config(), baggage=costs)

    cheapest = next(p for p in result.picks if p.label == "cheapest" or "cheapest" in p.also)
    assert cheapest.offer_key == offer_key(offers[0])
    assert result.cheapest_basis == "ticket"
