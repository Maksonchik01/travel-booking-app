"""Порівняння цін житла в продавців (модуль 7): mock-тарифи, групування, історія, API."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from tickets_api.domain.stay_rates import StayRate, StayRatesRequest
from tickets_api.domain.stays import Stay, StayQuery, StayReview
from tickets_api.providers.base import ProviderError
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.stay_search import StaySearchService, group_rates

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
QUERY = StayQuery(city="LIS", check_in=date(2026, 12, 5), check_out=date(2026, 12, 8))


def mock() -> MockStayProvider:
    return MockStayProvider(default_airport_directory(), clock=lambda: NOW)


def service(*providers: Any, record: Any = None) -> StaySearchService:
    return StaySearchService(
        list(providers),
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
        record_history=record,
    )


def rate(seller: str, price: str, **kw: Any) -> StayRate:
    fields: dict[str, Any] = {
        "room_name": "Стандартний двомісний номер",
        "room_code": "std",
        "bed_type": "double",
        "meal": "room_only",
        "cancellation": "free",
        "taxes_included": True,
        "fees_at_property": Decimal(0),
        "currency": "EUR",
        "checked_at": NOW,
        **kw,
    }
    return StayRate(seller=seller, price_total=Decimal(price), **fields)


def test_final_total_is_unknown_when_taxes_or_fees_are() -> None:
    assert rate("A", "300").final_total == Decimal(300)
    assert rate("A", "300", fees_at_property=Decimal(15)).final_total == Decimal(315)
    assert rate("A", "300", taxes_included=False, taxes=Decimal(30)).final_total == Decimal(330)
    assert rate("A", "300", taxes_included=False).final_total is None
    assert rate("A", "300", taxes_included=None).final_total is None
    assert rate("A", "300", fees_at_property=None).final_total is None


def test_groups_never_merge_different_rooms_or_conditions() -> None:
    rooms = group_rates(
        [
            rate("A", "300"),
            rate("B", "290", fees_at_property=Decimal(20)),  # 310 — дорожче за A
            rate("C", "250", fees_at_property=None),  # дешевше на вигляд, але збори невідомі
            rate("A", "260", cancellation="non_refundable"),
            rate("B", "320", meal="breakfast"),
            rate("A", "350", room_code="superior", room_name="Покращений номер"),
            rate("B", "340", room_code=None, room_name="Двомісний з видом"),
        ]
    )

    assert len(rooms) == 5
    base = rooms[0]  # група з кількома продавцями — перша
    assert [o.rate.seller for o in base.offers] == ["A", "B", "C"]
    assert [o.cheapest for o in base.offers] == [True, False, False]
    assert base.offers[2].final_total is None
    assert all(
        not o.cheapest for g in rooms[1:] for o in g.offers
    )  # один рядок — без «найдешевшого»
    assert {(g.meal, g.cancellation) for g in rooms} >= {
        ("room_only", "non_refundable"),
        ("breakfast", "free"),
    }


async def test_mock_rates_match_search_and_vary_in_transparency() -> None:
    stays = await mock().search(QUERY)
    by_sellers = {s.sellers for s in stays}
    assert len(by_sellers) > 1  # у різних об'єктів — різна кількість продавців
    assert None not in by_sellers

    stay = next(s for s in stays if (s.sellers or 0) >= 3)
    rates = await mock().rates(QUERY, stay.id)

    first = rates[0]
    assert first.price_total == stay.total_price  # перший продавець — рівно ціна з пошуку
    assert first.final_total == stay.total_price
    assert len({r.seller for r in rates}) == stay.sellers
    assert any(r.final_total is None for r in rates) or any(not r.taxes_included for r in rates)
    assert await mock().rates(QUERY, stay.id) == rates  # детерміновано
    assert await mock().rates(QUERY, "mock-lis-999") == []


class NoRates:
    name = "norates"

    async def search(self, query: StayQuery) -> list[Stay]:
        return []

    async def reviews(self, stay_id: str, *, limit: int = 30) -> list[StayReview]:
        return []


class BrokenRates(NoRates):
    name = "brokenrates"

    async def rates(self, query: StayQuery, stay_id: str) -> list[StayRate]:
        raise ProviderError("brokenrates", "HTTP 500")


async def test_service_rates_statuses_and_history() -> None:
    rows: list[dict[str, Any]] = []

    async def record(batch: list[dict[str, Any]]) -> None:
        rows.extend(batch)

    svc = service(mock(), NoRates(), BrokenRates(), record=record)
    result = await svc.rates(StayRatesRequest(query=QUERY, source="mock", stay_id="mock-lis-0"))

    assert result.status == "ok"
    assert result.rooms
    assert result.nights == 3
    assert result.checked_at == NOW
    total = sum(len(g.offers) for g in result.rooms)
    assert len(rows) == total
    assert all(r["seller"] and r["room"] and r["kind"] == "rate" for r in rows)
    request = StayRatesRequest(query=QUERY, source="norates", stay_id="x")
    assert (await svc.rates(request)).status == "unsupported"
    request = StayRatesRequest(query=QUERY, source="brokenrates", stay_id="x")
    assert (await svc.rates(request)).status == "error"
    request = StayRatesRequest(query=QUERY, source="nope", stay_id="x")
    assert (await svc.rates(request)).status == "unsupported"


async def test_stay_rates_api(client: AsyncClient) -> None:
    body = {
        "query": {"city": "LIS", "check_in": "2026-12-05", "check_out": "2026-12-08"},
        "source": "mock",
        "stay_id": "mock-lis-1",
    }

    response = await client.post("/stays/rates", json=body)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["rooms"][0]["offers"][0]["rate"]["seller"]
    search = await client.post("/stays/search", json=body["query"])
    assert all("sellers" in s for s in search.json()["stays"])


async def test_stay_detail_api(client: AsyncClient) -> None:
    """Сторінка об'єкта (ADR 0044): об'єкт з тієї самої видачі; зниклий — not_found."""
    query = {"city": "LIS", "check_in": "2026-12-05", "check_out": "2026-12-08"}

    found = await client.post(
        "/stays/detail", json={"query": query, "source": "mock", "stay_id": "mock-lis-1"}
    )
    gone = await client.post(
        "/stays/detail", json={"query": query, "source": "mock", "stay_id": "mock-lis-99"}
    )

    assert found.status_code == 200
    data = found.json()
    assert data["status"] == "ok"
    assert data["stay"]["id"] == "mock-lis-1"
    assert data["place"]["code"] == "LIS"
    assert gone.json()["status"] == "not_found"
