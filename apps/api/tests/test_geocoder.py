"""Місце біля житла (етап 5, ADR 0049): Nominatim на ЗАПИСАНІЙ відповіді (fixtures/nominatim/)."""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from flight_fakes import FakeRedis
from httpx import AsyncClient
from tickets_api.providers.geocoder import (
    DEFAULT_BASE_URL,
    SEARCH_PATH,
    GeocodeError,
    NominatimGeocoder,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "nominatim" / "search_belem_lisbon.json").read_text()
)
URL = f"{DEFAULT_BASE_URL}{SEARCH_PATH}"
UA = "SkyPack/1.0 (+https://example.test)"
LISBON = (38.72, -9.14)


@pytest.fixture
async def http() -> Any:
    async with httpx.AsyncClient() as c:
        yield c


@respx.mock
async def test_places_near_the_city_with_user_agent_and_cache(http: httpx.AsyncClient) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=FIXTURE))
    redis = FakeRedis()
    geocoder = NominatimGeocoder(http, redis, user_agent=UA)  # type: ignore[arg-type]

    places = await geocoder.search("  Belém ", center=LISBON, lang="uk")
    again = await geocoder.search("belém", center=LISBON, lang="uk")

    assert route.call_count == 1  # повтор — з кешу (політика Nominatim)
    request = route.calls[0].request
    assert request.headers["User-Agent"] == UA
    params = request.url.params
    assert (params["q"], params["format"], params["bounded"]) == ("Belém", "jsonv2", "1")
    west, north, east, south = (float(x) for x in params["viewbox"].split(","))
    assert west < LISBON[1] < east
    assert south < LISBON[0] < north
    assert places == again
    assert places[0].name == FIXTURE[0]["name"]
    assert places[0].lat == pytest.approx(float(FIXTURE[0]["lat"]))
    assert places[0].label == FIXTURE[0]["display_name"]
    # У ключі кешу — хеш, а не текст запиту людини.
    assert all("Belém" not in key and "belém" not in key for key in redis.store)


@respx.mock
async def test_bad_rows_are_skipped_and_errors_raise(http: httpx.AsyncClient) -> None:
    rows = [
        {"lat": "x", "lon": "1", "name": "bad"},
        {"lat": "10", "lon": "20", "display_name": "A, B"},
    ]
    respx.get(URL).mock(return_value=httpx.Response(200, json=rows))
    geocoder = NominatimGeocoder(http, None, user_agent=UA)

    places = await geocoder.search("A", center=None, lang="en")

    assert [(p.name, p.lat, p.lon) for p in places] == [("A", 10.0, 20.0)]
    respx.get(URL).mock(return_value=httpx.Response(429))
    with pytest.raises(GeocodeError):
        await geocoder.search("B", center=None, lang="en")


@respx.mock
async def test_geocode_api_is_graceful(client: AsyncClient) -> None:
    respx.route(host="test").pass_through()
    respx.get(URL).mock(return_value=httpx.Response(200, json=FIXTURE))

    ok = await client.get("/places/geocode", params={"q": "Belem", "city": "LIS"})

    assert ok.status_code == 200
    assert ok.json()["status"] == "ok"
    assert ok.json()["places"][0]["name"] == FIXTURE[0]["name"]

    respx.get(URL).mock(return_value=httpx.Response(503))
    failed = await client.get("/places/geocode", params={"q": "Rossio", "city": "LIS"})
    assert failed.json() == {"status": "error", "places": []}
