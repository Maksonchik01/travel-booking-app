from collections.abc import AsyncIterator
from typing import Any

import pytest
from asgi_lifespan import LifespanManager
from conftest import make_settings
from flight_fakes import FakeRedis
from httpx import ASGITransport, AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from tickets_api.main import create_app

CLICK = {"kind": "flight", "source": "serpapi", "host": "www.google.com"}
KEY = "k" * 32


class DownRedis(FakeRedis):
    async def incr(self, key: str) -> int:
        raise RedisConnectionError("down")


async def _client(redis: FakeRedis, **settings: Any) -> AsyncIterator[AsyncClient]:
    app = create_app(make_settings(rate_limit_clicks_per_hour=2, **settings))
    async with LifespanManager(app):
        real, app.state.redis = app.state.redis, redis
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        app.state.redis = real  # закриває lifespan


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async for c in _client(FakeRedis(), internal_api_key=KEY):
        yield c


async def click(client: AsyncClient, headers: dict[str, str] | None = None) -> int:
    return (await client.post("/outbound/clicks", json=CLICK, headers=headers)).status_code


async def test_over_limit_is_429_with_retry_after(client: AsyncClient) -> None:
    # Без БД запис — 503, але ліміт перевіряється раніше.
    assert [await click(client), await click(client)] == [503, 503]
    response = await client.post("/outbound/clicks", json=CLICK)
    assert response.status_code == 429
    assert 0 < int(response.headers["retry-after"]) <= 3600


async def test_trusted_client_ip_gets_own_bucket(client: AsyncClient) -> None:
    alice = {"x-client-ip": "203.0.113.1", "x-internal-key": KEY}
    bob = {"x-client-ip": "203.0.113.2", "x-internal-key": KEY}
    assert [await click(client, alice) for _ in range(3)] == [503, 503, 429]
    assert await click(client, bob) == 503


async def test_client_ip_without_key_is_ignored(client: AsyncClient) -> None:
    spoofed = [{"x-client-ip": f"198.51.100.{i}", "x-internal-key": "wrong"} for i in range(3)]
    assert [await click(client, h) for h in spoofed] == [503, 503, 429]


async def test_redis_down_lets_requests_through() -> None:
    async for client in _client(DownRedis()):
        assert [await click(client) for _ in range(3)] == [503, 503, 503]
