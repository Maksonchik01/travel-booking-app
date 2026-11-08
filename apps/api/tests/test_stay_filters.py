"""Розширені фільтри житла й фасети «які дані є» (модуль 5)."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError
from tickets_api.domain.stays import (
    GeoPoint,
    Guests,
    Stay,
    StayFilters,
    StayQuery,
    distance_between,
    normalize_rating,
)
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.stay_search import StaySearchService

NOW = datetime(2026, 11, 8, 12, tzinfo=UTC)
QUERY = StayQuery(city="LIS", check_in=date(2026, 12, 5), check_out=date(2026, 12, 8))
LISBON = GeoPoint(lat=38.7223, lon=-9.1393)


def stay(**over: Any) -> Stay:
    data: dict[str, Any] = {
        "id": "s",
        "source": "t",
        "name": "Test",
        "kind": "hotel",
        "price_per_night": Decimal(100),
        "total_price": Decimal(300),
        "currency": "EUR",
        "nights": 3,
        "collected_at": NOW,
    }
    data.update(over)
    return Stay.model_validate(data)


@pytest.mark.parametrize(
    ("filters", "ok", "rejected"),
    [
        ({"min_price_per_night": 90}, {}, {"price_per_night": 80}),
        ({"min_total_price": 250, "max_total_price": 350}, {}, {"total_price": 400}),
        ({"breakfast_included": True}, {"breakfast_included": True}, {"breakfast_included": None}),
        ({"no_prepayment": True}, {"prepayment": "none"}, {"prepayment": "required"}),
        ({"pay_at_property": True}, {"pay_at_property": True}, {}),
        (
            {"amenities": ["pool", "spa"]},
            {"amenities": ["pool", "spa", "wifi"]},
            {"amenities": ["pool"]},
        ),
        ({"min_beds": 3}, {"beds": 4}, {"beds": None}),
        (
            {"max_distance_center_km": 2},
            {"distance_to_center_km": 1.5},
            {"distance_to_center_km": None},
        ),
        ({"districts": ["Центр"]}, {"district": "Центр"}, {"district": "Набережна"}),
        (
            {"near": LISBON.model_dump(), "radius_km": 3},
            {"latitude": 38.73, "longitude": -9.14},
            {"latitude": 38.80, "longitude": -9.30},
        ),
        ({"kinds": ["other"]}, {"kind": "other"}, {"kind": "hostel"}),
    ],
)
def test_filters_keep_confirmed_and_drop_unknown(
    filters: dict[str, Any], ok: dict[str, Any], rejected: dict[str, Any]
) -> None:
    f = StayFilters.model_validate(filters)
    assert f.matches(stay(**ok))
    # Людина явно обрала умову — невідоме значення не видаємо за підтверджене.
    assert not f.matches(stay(**{**ok, **rejected}) if rejected else stay())


def test_guests_rules() -> None:
    assert Guests(adults=2, children=2, children_ages=[1, 7], rooms=2).rooms == 2
    with pytest.raises(ValidationError, match="кожної дитини"):
        Guests(adults=2, children=2, children_ages=[5])
    with pytest.raises(ValidationError, match="0 до 17"):
        Guests(adults=2, children=1, children_ages=[18])
    with pytest.raises(ValidationError, match="кімнат"):
        Guests(adults=1, rooms=2)


def test_rating_scales_are_normalized() -> None:
    assert normalize_rating(4.3, 5) == Decimal("8.6")
    assert normalize_rating(87, 100) == Decimal("8.7")
    assert normalize_rating(Decimal("9.1"), 10) == Decimal("9.1")
    with pytest.raises(ValueError, match="шкалою"):
        normalize_rating(6, 5)


def mock() -> MockStayProvider:
    return MockStayProvider(airports=default_airport_directory(), clock=lambda: NOW)


async def test_mock_prices_rooms_and_free_infants() -> None:
    def query(**guests: Any) -> StayQuery:
        return QUERY.model_copy(update={"guests": Guests(**guests)})

    one_room = {s.name: s for s in await mock().search(query(adults=2))}
    two_rooms = {s.name: s for s in await mock().search(query(adults=2, rooms=2))}
    hotel = "Hotel Meridian"
    assert two_rooms[hotel].price_per_night > one_room[hotel].price_per_night
    assert two_rooms[hotel].rooms == 2

    with_baby = {
        s.name: s for s in await mock().search(query(adults=2, children=1, children_ages=[1]))
    }
    with_kid = {
        s.name: s for s in await mock().search(query(adults=2, children=1, children_ages=[9]))
    }
    # Немовля до 2 років місця не займає — дешевше, ніж з 9-річною дитиною.
    assert with_baby[hotel].price_per_night < with_kid[hotel].price_per_night


async def test_facets_show_only_filters_with_data() -> None:
    svc = StaySearchService(
        [mock()],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
    )
    result = await svc.search(QUERY)

    facets = result.facets
    assert set(facets.available) >= {
        "rating",
        "breakfast",
        "prepayment",
        "beds",
        "coordinates",
        "district",
    }
    assert any(a.value == "balcony" for a in facets.amenities)
    assert facets.min_total_price is not None
    assert facets.max_total_price is not None
    assert facets.min_total_price <= facets.max_total_price

    class Bare:
        name = "bare"

        async def search(self, query: Any) -> list[Stay]:
            return [stay()]

        async def reviews(self, stay_id: str, *, limit: int = 30) -> list[Any]:
            return []

    bare = StaySearchService(
        [Bare()],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
    )
    # Джерело не дає ні сніданку, ні координат — таких фільтрів у UI не буде.
    assert (await bare.search(QUERY)).facets.available == []


async def test_near_airport_uses_directory_coordinates() -> None:
    svc = StaySearchService(
        [mock()],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
    )
    near = QUERY.model_copy(update={"filters": StayFilters(near_airport="LIS", radius_km=6)})

    everything = await svc.search(QUERY)
    result = await svc.search(near)

    assert result.place is not None
    assert "LIS" in result.place.airports
    lat, lon = default_airport_directory().coordinates("LIS") or (0.0, 0.0)
    airport = GeoPoint(lat=lat, lon=lon)
    assert 0 < len(result.stays) < len(everything.stays)
    assert all(
        distance_between(airport, s.latitude or 0, s.longitude or 0) <= 6 for s in result.stays
    )


def test_bbox_keeps_only_stays_inside_the_map_area() -> None:
    box = StayFilters(bbox={"south": 38.70, "west": -9.20, "north": 38.76, "east": -9.10})
    assert box.matches(stay(latitude=38.72, longitude=-9.14))
    assert not box.matches(stay(latitude=38.80, longitude=-9.14))
    assert not box.matches(stay())  # без координат — місце невідоме, в область не потрапляє
    across = StayFilters(bbox={"south": -20, "west": 170, "north": -10, "east": -170})
    assert across.matches(stay(latitude=-15, longitude=179))  # Фіджі через 180-й меридіан
    with pytest.raises(ValidationError, match="південна"):
        StayFilters(bbox={"south": 40, "west": 0, "north": 39, "east": 1})
