"""Mock-провайдер житла, сервіс пошуку (graceful degradation, фільтри, історія) і API."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from tickets_api.domain.stays import Stay, StayFilters, StayQuery, StayReview
from tickets_api.providers.base import ProviderError
from tickets_api.providers.mock_stays import INJECTION, MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.stay_search import StaySearchService

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


class Broken:
    name = "broken"

    async def search(self, query: StayQuery) -> list[Stay]:
        raise ProviderError("broken", "HTTP 500")

    async def reviews(self, stay_id: str, *, limit: int = 30) -> list[StayReview]:
        raise ProviderError("broken", "HTTP 500")


def test_query_validates_dates() -> None:
    with pytest.raises(ValidationError):
        StayQuery(city="LIS", check_in=date(2026, 12, 8), check_out=date(2026, 12, 8))
    with pytest.raises(ValidationError):
        StayQuery(city="LIS", check_in=date(2026, 12, 1), check_out=date(2027, 1, 15))
    assert QUERY.nights == 3


async def test_mock_is_deterministic_and_consistent() -> None:
    first, second = await mock().search(QUERY), await mock().search(QUERY)

    assert first == second
    assert len(first) == 18
    for stay in first:
        assert stay.total_price == stay.price_per_night * 3
        reviews = await mock().reviews(stay.id)
        assert len(reviews) == min(30, stay.review_count)
    # Об'єкт сталий, ціна залежить від дат.
    later = await mock().search(QUERY.model_copy(update={"check_in": date(2026, 12, 6)}))
    assert [s.rating for s in later] == [s.rating for s in first]
    assert [s.price_per_night for s in later] != [s.price_per_night for s in first]


async def test_mock_airport_code_means_its_city_and_guests_raise_price() -> None:
    waw = await mock().search(QUERY.model_copy(update={"city": "WAW"}))
    family = await mock().search(
        StayQuery.model_validate({**QUERY.model_dump(), "guests": {"adults": 4}})
    )
    base = await mock().search(QUERY)

    assert waw
    assert all(s.id.startswith("mock-waw-") for s in waw)
    assert all(f.price_per_night > b.price_per_night for f, b in zip(family, base, strict=True))
    assert await mock().search(QUERY.model_copy(update={"city": "QQQ"})) == []


async def test_mock_reviews_contain_injection_attempt() -> None:
    reviews = await mock().reviews("mock-lis-3")

    assert reviews[0].text == INJECTION


async def test_search_scores_filters_and_records_history() -> None:
    rows: list[dict[str, Any]] = []

    async def record(batch: list[dict[str, Any]]) -> None:
        rows.extend(batch)

    query = QUERY.model_copy(
        update={"filters": StayFilters(max_price_per_night=150, free_cancellation=True)}
    )
    result = await service(mock(), record=record).search(query)

    assert result.place is not None
    assert result.place.name == "Лісабон"
    assert result.stays
    assert all(s.price_per_night <= Decimal(150) and s.cancellation == "free" for s in result.stays)
    assert len(rows) == 18  # в історію — усе отримане, не лише відфільтроване
    assert result.facets.total_stays == 18
    assert {p.label for p in result.scoring.picks} <= {"cheapest", "balanced", "top_rated"}
    assert len(result.scoring.scores) == len(result.stays)


async def test_broken_provider_does_not_break_search() -> None:
    result = await service(Broken(), mock()).search(QUERY)

    statuses = {p.provider: p.status for p in result.providers}
    assert statuses == {"broken": "error", "mock": "ok"}
    assert len(result.stays) == 18
    assert await service(Broken()).reviews("broken", "x") == []


async def test_stays_api(client: AsyncClient) -> None:
    body = {"city": "lis", "check_in": "2026-12-05", "check_out": "2026-12-08"}

    response = await client.post("/stays/search", json=body)

    assert response.status_code == 200
    data = response.json()
    assert data["place"]["code"] == "LIS"
    assert data["stays"][0]["price_per_night"] > 0
    assert data["scoring"]["picks"]
    bad = {**body, "check_out": "2026-12-05"}
    assert (await client.post("/stays/search", json=bad)).status_code == 422
