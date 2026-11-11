"""Неправдоподібні пропозиції (V3, етап 6, ADR 0059).

Спершу — кожне правило на штучних даних; потім головне: жодна ЗАПИСАНА реальна відповідь
джерел (SerpApi, scrape.do, Travelpayouts, Google Hotels) правилами не відкидається.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx
import test_scrapedo_provider as sdo
import test_scrapedo_stays as sdo_stays
import test_serpapi_provider as serp
import test_travelpayouts_provider as tp
from flight_fakes import offers_for
from tickets_api.domain import sanity
from tickets_api.domain.flights import FlightQuery, Leg, Offer, Segment
from tickets_api.domain.sanity import drop_implausible, offer_problems, stay_problems
from tickets_api.providers.scrapedo import ScrapeDoFlightProvider
from tickets_api.providers.travelpayouts import PRICES_FOR_DATES, TravelpayoutsFlightProvider
from tickets_api.reference.airports import default_airport_directory

DAY = datetime(2026, 11, 10, 6, 0, tzinfo=UTC)
QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))


def offer(**overrides: Any) -> Offer:
    return offers_for("t", [100])[0].model_copy(update=overrides)


def leg(**overrides: Any) -> Leg:
    data: dict[str, Any] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_at": DAY,
        "arrival_at": DAY + timedelta(hours=4),
        "duration_min": 240,
        "stops": 0,
    }
    data.update(overrides)
    return Leg.model_validate(data)


def segment(start: datetime, minutes: int) -> Segment:
    return Segment(
        origin="WAW",
        destination="LIS",
        departure_at=start,
        arrival_at=start + timedelta(minutes=minutes),
        carrier="LO",
        flight_number="LO1",
        duration_min=minutes,
    )


def test_plausible_offer_has_no_problems() -> None:
    assert offer_problems(offer(outbound=leg()), QUERY) == []


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"outbound": leg(arrival_at=DAY - timedelta(hours=1))}, "arrival_before_departure"),
        ({"outbound": leg(duration_min=5)}, "implausible_duration"),
        ({"outbound": leg(duration_min=80 * 60)}, "implausible_duration"),
        (
            {"inbound": leg(departure_at=DAY + timedelta(hours=2), arrival_at=None)},
            "return_before_arrival",
        ),
        ({"taxes": Decimal(150)}, "taxes_exceed_price"),
        (
            {"outbound": leg(departure_at=DAY + timedelta(days=5), arrival_at=None)},
            "date_outside_query",
        ),
    ],
)
def test_each_rule(overrides: dict[str, Any], code: str) -> None:
    assert code in offer_problems(offer(**{"outbound": leg(), **overrides}), QUERY)


def test_segments_must_follow_each_other() -> None:
    bad = leg(
        stops=1,
        layovers=None,
        segments=[segment(DAY, 120), segment(DAY + timedelta(minutes=60), 120)],
    )
    assert "segments_out_of_order" in offer_problems(offer(outbound=bad), QUERY)


def test_overnight_and_timezone_crossing_flights_are_fine() -> None:
    # Нічний рейс на захід: місцевий час прильоту «раніше», абсолютний — пізніше.
    west = leg(
        departure_at=datetime(2026, 11, 10, 23, 30, tzinfo=UTC),
        arrival_at=datetime(2026, 11, 10, 22, 0, tzinfo=UTC) + timedelta(hours=9),
        duration_min=7 * 60 + 30,
    )
    # Виліт за день до запиту в місцевому часі — у межах запасу на пояси.
    early = leg(departure_at=DAY - timedelta(days=1), arrival_at=None)
    assert offer_problems(offer(outbound=west), QUERY) == []
    assert offer_problems(offer(outbound=early), QUERY) == []


def test_dropped_items_are_logged_by_code_without_details(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    class Spy:
        def warning(self, event: str, **fields: Any) -> None:
            events.append((event, fields))

    monkeypatch.setattr(sanity, "log", Spy())
    good, bad = offer(outbound=leg()), offer(id="bad", taxes=Decimal(500))
    kept = drop_implausible([good, bad], lambda o: offer_problems(o, QUERY), "flights")

    assert kept == [good]
    assert events == [
        (
            "search.implausible_dropped",
            {"kind": "flights", "problems": {"t:taxes_exceed_price": 1}},
        )
    ]  # лише коди — без маршрутів і цін


# --- реальні відповіді джерел -------------------------------------------------------------


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


@respx.mock
async def test_recorded_serpapi_offers_are_all_plausible(client: httpx.AsyncClient) -> None:
    respx.get(serp.URL).mock(return_value=httpx.Response(200, json=serp.recorded("oneway")))
    query = serp.one_way()
    offers = await serp.make_provider(client).search(query)
    assert offers
    assert {o.id: offer_problems(o, query) for o in offers if offer_problems(o, query)} == {}


@respx.mock
async def test_recorded_scrapedo_round_trips_are_all_plausible(client: httpx.AsyncClient) -> None:
    sdo.mock_directions()
    query = sdo.query(return_date=date(2026, 12, 20))
    provider = ScrapeDoFlightProvider(
        client, sdo.TOKEN, airports=default_airport_directory(), base_url=sdo.BASE
    )
    offers = await provider.search(query)
    assert offers
    assert [offer_problems(o, query) for o in offers] == [[] for _ in offers]


@respx.mock
async def test_recorded_travelpayouts_offers_are_all_plausible(client: httpx.AsyncClient) -> None:
    respx.get(f"{tp.BASE}{PRICES_FOR_DATES}").mock(
        return_value=httpx.Response(200, json=tp.recorded("prices_for_dates_rt"))
    )
    query = tp.query()
    provider = TravelpayoutsFlightProvider(client, "token", base_url=tp.BASE)
    offers = await provider.search(query)
    assert offers
    assert [offer_problems(o, query) for o in offers] == [[] for _ in offers]


@respx.mock
async def test_recorded_google_hotels_stays_are_all_plausible(client: httpx.AsyncClient) -> None:
    sdo_stays.mock_api()
    stays = await sdo_stays.make(client).search(sdo_stays.QUERY)
    assert stays
    assert [stay_problems(s, sdo_stays.QUERY) for s in stays] == [[] for _ in stays]

    # Ті самі дані, зіпсовані: сума вдесятеро більша за «ціна за ніч × ночі», інші ночі.
    stay = stays[0]
    broken = stay.model_copy(update={"total_price": stay.total_price * 10})
    longer = sdo_stays.QUERY.model_copy(update={"check_out": date(2026, 12, 20)})
    assert stay_problems(broken, sdo_stays.QUERY) == ["price_inconsistent"]
    assert stay_problems(stay, longer) == ["nights_mismatch"]


async def test_search_service_drops_implausible_offers_before_history() -> None:
    from flight_fakes import StubProvider
    from test_flight_search_service import HistorySpy, service

    history = HistorySpy()
    good = offer(outbound=leg())
    bad = offer(id="bad", outbound=leg(arrival_at=DAY - timedelta(hours=2)))
    result = await service(StubProvider("t", offers=[good, bad]), history=history).search(QUERY)

    assert [o.id for o in result.offers] == [good.id]
    assert len(history.rows) == 1  # хибна ціна не псує історію
