import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import respx
from asgi_lifespan import LifespanManager
from conftest import make_settings
from httpx import ASGITransport, AsyncClient
from tickets_api.main import create_app

KEY = "o" * 32
ACCOUNT = {
    "account_email": "owner@example.com",
    "api_key": "secret",
    "searches_per_month": 250,
    "this_month_usage": 42,
    "plan_searches_left": 208,
    "total_searches_left": 208,
    "this_hour_searches": 1,
}


async def _client(**settings: Any) -> AsyncIterator[AsyncClient]:
    app = create_app(make_settings(**settings))
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


async def get_summary(headers: dict[str, str] | None = None, **settings: Any) -> httpx.Response:
    async for client in _client(**settings):
        return await client.get("/ops/summary", headers=headers)
    raise AssertionError


async def test_disabled_without_internal_key() -> None:
    assert (await get_summary({"x-internal-key": KEY})).status_code == 404


@pytest.mark.parametrize("headers", [None, {"x-internal-key": "wrong"}])
async def test_wrong_key_is_401(headers: dict[str, str] | None) -> None:
    response = await get_summary(headers, internal_api_key=KEY)
    assert response.status_code == 401


@respx.mock
async def test_serpapi_counters_only_and_database_problem_reported() -> None:
    respx.get("https://serpapi.test/account.json").mock(
        return_value=httpx.Response(200, json=ACCOUNT)
    )
    response = await get_summary(
        {"x-internal-key": KEY},
        internal_api_key=KEY,
        serpapi_key="k",
        serpapi_base_url="https://serpapi.test",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["serpapi"] == {k: v for k, v in ACCOUNT.items() if isinstance(v, int)}
    assert "owner@example.com" not in response.text
    assert "secret" not in response.text
    assert body["llm"] is None
    assert body["clicks"] is None
    assert body["problems"] == ["database: ConnectionRefusedError"]


@respx.mock
async def test_serpapi_down_does_not_break_summary() -> None:
    respx.get("https://serpapi.test/account.json").mock(return_value=httpx.Response(503))
    response = await get_summary(
        {"x-internal-key": KEY},
        internal_api_key=KEY,
        serpapi_key="k",
        serpapi_base_url="https://serpapi.test",
    )
    assert response.status_code == 200
    assert response.json()["serpapi"] is None
    assert response.json()["problems"][0] == "serpapi: HTTPStatusError"


@pytest.mark.integration
async def test_database_sections_with_live_db() -> None:
    db_url, redis_url = os.environ.get("TEST_DATABASE_URL"), os.environ.get("TEST_REDIS_URL")
    if not db_url or not redis_url:
        pytest.skip("TEST_DATABASE_URL / TEST_REDIS_URL не задані")
    async for client in _client(internal_api_key=KEY, database_url=db_url, redis_url=redis_url):
        await client.post(
            "/outbound/clicks",
            json={"kind": "flight", "source": "ops_test", "host": "www.aviasales.com"},
        )
        body = (await client.get("/ops/summary", headers={"x-internal-key": KEY})).json()
        assert body["problems"] == []
        assert body["serpapi"] is None  # ключа немає — секції немає, це не проблема
        assert body["clicks"]["by_source_7d"]["ops_test"] >= 1
        assert body["clicks"]["total_24h"] >= 1
        assert body["activity"]["users"] >= 0
