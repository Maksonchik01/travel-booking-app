"""Недоступна база (V3, етап 7): пошук працює, а кабінет, вхід і публічна поїздка — 503
`unavailable` з Retry-After, а не голий 500 (веб показує «тимчасово недоступно» з повтором)."""

from collections.abc import AsyncIterator

import pytest
from asgi_lifespan import LifespanManager
from conftest import make_settings
from httpx import ASGITransport, AsyncClient
from tickets_api.main import create_app

QUERY = {
    "origin": "WAW",
    "destination": "LIS",
    "departure_date": "2026-12-05",
    "return_date": "2026-12-08",
}


@pytest.fixture
async def db_down() -> AsyncIterator[AsyncClient]:
    app = create_app(make_settings())  # make_settings: недосяжні база й Redis
    async with LifespanManager(app):
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


async def test_search_keeps_working_without_database(db_down: AsyncClient) -> None:
    for path, body in [
        ("/flights/search", QUERY),
        ("/trips/search", QUERY),
        ("/stays/search", {"city": "LIS", "check_in": "2026-12-05", "check_out": "2026-12-08"}),
    ]:
        assert (await db_down.post(path, json=body)).status_code == 200, path


async def test_account_login_and_shared_trip_say_unavailable(db_down: AsyncClient) -> None:
    session = {"authorization": "Bearer " + "x" * 43}
    responses = [
        await db_down.get("/account", headers=session),
        await db_down.post("/auth/login", json={"login": "someone", "password": "password123"}),
        await db_down.get("/shared/trips/abcdefghijklmnopqrstuv"),
    ]
    for response in responses:
        assert response.status_code == 503
        assert response.json() == {"detail": "unavailable"}
        assert response.headers["retry-after"] == "30"
