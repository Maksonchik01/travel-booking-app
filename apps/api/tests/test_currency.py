"""Модуль 18.2: одна валюта порівняння, конвертація за курсом, округлення, вихідна ціна."""

from datetime import date
from decimal import Decimal

import pytest
from flight_fakes import StubProvider, offers_for
from test_trip_planner import DAY, NIGHT, STUB_QUERY
from tickets_api.domain.flights import BagAllowance, Baggage, FlightQuery
from tickets_api.domain.money import convert, to_cents
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.scoring.trip import default_trip_scoring_config
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner

QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))
# 1 EUR = 4.3 PLN; 1 PLN = 0.2326 EUR (як дав би ЄЦБ через крос-курс).
RATES = {("EUR", "PLN"): Decimal("4.3"), ("PLN", "EUR"): Decimal("0.2326")}


async def rate(base: str, currency: str) -> Decimal | None:
    return RATES.get((base, currency))


def service(*offers_sources: list) -> FlightSearchService:  # type: ignore[type-arg]
    return FlightSearchService(
        [StubProvider(f"s{i}", offers=o) for i, o in enumerate(offers_sources)],
        timeout_s=1,
        scoring_config=default_scoring_config(),
        fx=rate,
    )


@pytest.mark.parametrize(
    ("value", "expected"),
    [("1.005", "1.01"), ("1.004", "1.00"), ("2.675", "2.68"), ("-1.005", "-1.01")],
)
def test_rounding_is_half_up_to_cents(value: str, expected: str) -> None:
    assert to_cents(Decimal(value)) == Decimal(expected)


def test_convert_rounds_once_at_the_end() -> None:
    assert convert(Decimal("100"), Decimal("0.2326")) == Decimal("23.26")
    assert convert(Decimal("33.33"), Decimal("4.3")) == Decimal("143.32")  # 143.319


async def test_offer_in_other_currency_is_compared_in_search_currency() -> None:
    eur = offers_for("eur", [100])
    pln = [
        o.model_copy(update={"currency": "PLN", "price": Decimal(400)})
        for o in offers_for("pln", [1])
    ]

    result = await service(eur, pln).search(QUERY)

    # Вихідна ціна у видачі — як дало джерело.
    original = next(o for o in result.offers if o.source == "pln")
    assert (original.price, original.currency) == (Decimal(400), "PLN")
    # Для порівняння — у EUR, орієнтовно, з курсом.
    conv = result.converted["pln:pln-0"]
    assert (conv.amount, conv.currency, conv.rate) == (Decimal("93.04"), "EUR", Decimal("0.2326"))
    assert conv.approximate is True
    assert result.scoring.unscored_offer_keys == []
    cheapest = next(
        p for p in result.scoring.picks if p.label == "cheapest" or "cheapest" in p.also
    )
    assert cheapest.offer_key == "pln:pln-0"  # 93,04 € < 100 €


async def test_without_rate_other_currency_is_not_compared() -> None:
    usd = [o.model_copy(update={"currency": "USD"}) for o in offers_for("usd", [50])]
    result = await service(offers_for("eur", [100]), usd).search(QUERY)
    assert result.converted == {}
    assert result.scoring.unscored_offer_keys == ["usd:usd-0"]


async def test_baggage_fees_are_converted_with_the_price() -> None:
    bags = Baggage(
        personal_item=BagAllowance(status="included"),
        checked=BagAllowance(status="fee", fee=Decimal(100)),
    )
    pln = [
        o.model_copy(update={"currency": "PLN", "price": Decimal(400), "baggage": bags})
        for o in offers_for("pln", [1])
    ]
    result = await service(pln).search(QUERY.model_copy(update={"baggage": "checked"}))
    cost = result.baggage["pln:pln-0"]
    assert cost.extra == Decimal("23.26")
    assert cost.total == Decimal("116.30")  # 93,04 + 23,26 — усе в EUR


def test_stay_and_trip_weights_follow_the_currency() -> None:
    stays = default_stay_scoring_config().in_currency("PLN", Decimal("4.3"))
    base = default_stay_scoring_config()
    assert stays.penalties.non_refundable == base.penalties.non_refundable * Decimal("4.3")
    assert stays.thresholds == base.thresholds  # кілометри й бали — як є
    trip = default_trip_scoring_config().in_currency("PLN", Decimal("4.3"))
    assert (
        trip.timing.night_arrival
        == default_trip_scoring_config().timing.night_arrival * Decimal("4.3")
    )
    assert (
        trip.timing.night_arrival_before
        == default_trip_scoring_config().timing.night_arrival_before
    )


async def test_trip_with_stay_in_other_currency_is_approximate() -> None:
    class PlnStays(MockStayProvider):
        async def search(self, query):  # type: ignore[no-untyped-def]
            found = await super().search(query.model_copy(update={"currency": "PLN"}))
            return found

    flights = FlightSearchService(
        [StubProvider("stub", [NIGHT, DAY])],
        timeout_s=1,
        scoring_config=default_scoring_config(),
        fx=rate,
    )
    stays = StaySearchService(
        [PlnStays(default_airport_directory())],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
        rate=flights.rate,
    )
    result = await TripPlanner(flights, stays).plan(STUB_QUERY)

    assert result.combos, "комбінації є, хоч житло в PLN"
    combo = result.combos[0]
    assert combo.currency == "EUR"
    assert combo.converted_from == ["PLN"]
    stay_item = next(i for i in combo.costs.items if i.kind == "stay")
    assert stay_item.status == "approximate"  # переведене — не гарантована сума
    # Житло у видачі — у вихідній валюті.
    assert result.stays[combo.stay_index].currency == "PLN"
