"""Житло з Google Hotels через scrape.do (ADR 0044) на ЗАПИСАНИХ відповідях (fixtures/scrapedo/)."""

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from flight_fakes import FakeRedis
from tickets_api.core.config import Settings
from tickets_api.domain.stay_rates import StayRatesRequest
from tickets_api.domain.stays import Guests, StayQuery
from tickets_api.providers.base import ProviderUnsupportedError
from tickets_api.providers.cached import CachedStayProvider
from tickets_api.providers.scrapedo_stays import (
    DETAIL_PATH,
    HOTELS_PATH,
    ScrapeDoStayProvider,
)
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.stays import default_stay_scoring_config
from tickets_api.services.stay_search import StayDetailRequest, StaySearchService

BASE = "https://sdo.test"
TOKEN = "secret-sdo-token"  # noqa: S105
NOW = datetime(2026, 11, 10, 12, tzinfo=UTC)
FIXTURES = Path(__file__).parent / "fixtures" / "scrapedo"
QUERY = StayQuery(city="LIS", check_in=date(2026, 12, 13), check_out=date(2026, 12, 16))
LISTING = json.loads((FIXTURES / "hotels_lis_2026-12-13.json").read_text())
DETAIL = json.loads((FIXTURES / "hotel_detail_lis_0.json").read_text())


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


def make(client: httpx.AsyncClient) -> ScrapeDoStayProvider:
    return ScrapeDoStayProvider(
        client, TOKEN, airports=default_airport_directory(), base_url=BASE, clock=lambda: NOW
    )


def mock_api() -> tuple[respx.Route, respx.Route]:
    hotels = respx.get(f"{BASE}{HOTELS_PATH}").mock(return_value=httpx.Response(200, json=LISTING))
    detail = respx.get(f"{BASE}{DETAIL_PATH}").mock(return_value=httpx.Response(200, json=DETAIL))
    return hotels, detail


@respx.mock
async def test_listing_becomes_stays_with_photos_and_description(client: httpx.AsyncClient) -> None:
    hotels, _ = mock_api()

    stays = await make(client).search(QUERY)

    params = hotels.calls[0].request.url.params
    assert params["q"] == "Lisbon hotels"
    assert (params["check_in_date"], params["check_out_date"]) == ("2026-12-13", "2026-12-16")
    assert params["token"] == TOKEN
    assert len(stays) == 20
    first = next(s for s in stays if s.name == "The One Palácio da Anunciada")
    raw = LISTING["properties"][0]
    assert first.source == "scrapedo"
    assert first.stars == 5
    assert first.rating == Decimal("9.4")  # 4.7 з 5
    assert first.review_count == raw["reviews"]
    assert first.total_price == Decimal("599.00")
    assert first.price_per_night == Decimal("199.74")
    assert first.nights == 3
    assert first.taxes_included is None
    assert first.description is not None
    assert first.description.startswith("Plush rooms")
    assert (first.check_in_time, first.check_out_time) == ("3:00 PM", "12:00 PM")
    assert first.booking_ref == raw["detail_token"]
    # Мініатюра — для картки, великі — для сторінки об'єкта; лише хост фото Google.
    assert first.image_url == raw["images"][0]["thumbnail"]
    assert len(first.images) == len(raw["images"])
    assert all(
        u.startswith("https://lh3.googleusercontent.com/") and u.endswith("=w1280-h853-k-no")
        for u in first.images
    )
    assert first.deep_link is not None
    assert first.deep_link.startswith("https://www.google.com/travel/search?q=")
    assert first.distance_to_center_km is not None
    # Невідоме лишається невідомим: умов скасування, сніданку й зручностей джерело не дає.
    assert first.cancellation is None
    assert first.breakfast_included is None
    assert first.amenities == []
    assert len({s.id for s in stays}) == 20


@respx.mock
async def test_photo_from_other_host_is_dropped(client: httpx.AsyncClient) -> None:
    body = json.loads(json.dumps(LISTING))
    body["properties"][0]["images"] = [
        {"thumbnail": "https://evil.example/x.jpg", "original_image": "https://evil.example/x.jpg"}
    ]
    respx.get(f"{BASE}{HOTELS_PATH}").mock(return_value=httpx.Response(200, json=body))

    stays = await make(client).search(QUERY)

    first = next(s for s in stays if s.name == "The One Palácio da Anunciada")
    assert first.image_url is None
    assert first.images == []


@pytest.mark.parametrize(
    "guests",
    [Guests(adults=3), Guests(adults=2, children=1), Guests(adults=2, rooms=2)],
)
async def test_other_party_is_unsupported(client: httpx.AsyncClient, guests: Guests) -> None:
    # Google Hotels рахує лише двох дорослих в одному номері — ціну не вигадуємо.
    with pytest.raises(ProviderUnsupportedError):
        await make(client).search(QUERY.model_copy(update={"guests": guests}))


@respx.mock
async def test_rates_use_cached_search_and_detail_sellers(client: httpx.AsyncClient) -> None:
    hotels, detail = mock_api()
    provider = make(client)
    cached = CachedStayProvider(provider, FakeRedis(), 1800)  # type: ignore[arg-type]
    provider.lookup = cached.search
    stays = await cached.search(QUERY)
    stay = next(s for s in stays if s.name == "The One Palácio da Anunciada")

    rates = await cached.rates(QUERY, stay.id)
    again = await cached.rates(QUERY, stay.id)

    assert hotels.call_count == 1  # тарифи взяли detail_token з кешу пошуку
    assert detail.call_count == 1  # повторне відкриття — з кешу
    assert detail.calls[0].request.url.params["detail_token"] == stay.booking_ref
    assert rates == again
    sources = DETAIL["property"]["booking_sources"]
    assert len(rates) == len(sources)
    own = next(r for r in rates if r.is_property)
    assert own.seller == "The One Palácio da Anunciada"
    assert own.price_total == Decimal("599.22")
    assert all(r.room_name == "" and r.taxes_included is None for r in rates)
    assert all(
        r.deep_link is None or r.deep_link.startswith("https://www.google.com/") for r in rates
    )
    assert sum(r.sponsored for r in rates) == sum(1 for s in sources if s.get("sponsored"))


@respx.mock
async def test_detail_endpoint_finds_stay_without_new_request(client: httpx.AsyncClient) -> None:
    hotels, _ = mock_api()
    provider = make(client)
    cached = CachedStayProvider(provider, FakeRedis(), 1800)  # type: ignore[arg-type]
    svc = StaySearchService(
        [cached],
        airports=default_airport_directory(),
        timeout_s=1,
        scoring_config=default_stay_scoring_config(),
        clock=lambda: NOW,
    )
    found = (await svc.search(QUERY)).stays[0]

    result = await svc.detail(StayDetailRequest(query=QUERY, source="scrapedo", stay_id=found.id))
    missing = await svc.detail(StayDetailRequest(query=QUERY, source="scrapedo", stay_id="gh-x"))
    family = await svc.detail(
        StayDetailRequest(
            query=QUERY.model_copy(update={"guests": Guests(adults=4)}),
            source="scrapedo",
            stay_id=found.id,
        )
    )

    assert hotels.call_count == 1
    assert result.status == "ok"
    assert result.stay == found
    assert result.place is not None
    assert result.freshness == "live"
    assert missing.status == "not_found"
    assert family.status == "unsupported"
    rates = await svc.rates(StayRatesRequest(query=QUERY, source="nope", stay_id=found.id))
    assert rates.status == "unsupported"


def test_settings_require_token_for_paid_stays() -> None:
    with pytest.raises(ValueError, match="STAY_PROVIDERS"):
        Settings(_env_file=None, stay_providers=["scrapedo"])
    settings = Settings(
        _env_file=None,
        stay_providers=["scrapedo"],
        scrapedo_token="t",  # noqa: S106
    )
    assert settings.stay_providers == ["scrapedo"]
