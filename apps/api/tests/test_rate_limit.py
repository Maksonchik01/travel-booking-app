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


# --- Кошики за вартістю, акаунт, одночасні пошуки, розмір тіла (ADR 0056) ---

TRIP = {
    "origin": "WAW",
    "destination": "LIS",
    "departure_date": "2026-12-05",
    "return_date": "2026-12-08",
}
FLIGHT = {"origin": "WAW", "destination": "LIS", "departure_date": "2026-12-05"}


class StubAccounts:
    """Сесія «good» — користувач u1; решта токенів — невідомі."""

    def __init__(self) -> None:
        self.lookups = 0

    async def user_for_session(self, token: str) -> Any:
        self.lookups += 1
        return type("User", (), {"id": "u1"})() if token == "good" else None  # noqa: S105


async def _app_client(redis: FakeRedis, **settings: Any) -> AsyncIterator[tuple[Any, AsyncClient]]:
    app = create_app(make_settings(**settings))
    async with LifespanManager(app):
        real, app.state.redis = app.state.redis, redis
        app.state.accounts = StubAccounts()
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield app, client
        app.state.redis = real


async def test_expensive_operations_have_their_own_smaller_bucket() -> None:
    async for _, client in _app_client(
        FakeRedis(), rate_limit_heavy_per_hour=1, rate_limit_search_per_hour=10
    ):
        assert (await client.post("/trips/search", json=TRIP)).status_code == 200
        assert (await client.post("/trips/search", json=TRIP)).status_code == 429
        # Звичайний пошук рейсів — інший кошик: поїздка його не вичерпала.
        assert (await client.post("/flights/search", json=FLIGHT)).status_code == 200


async def test_lookups_are_limited_too() -> None:
    redis = FakeRedis()
    async for _, client in _app_client(redis, rate_limit_lookup_per_hour=2):
        codes = [(await client.get("/places/countries")).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
    # Моніторинг (ADR 0062): відмова порахована за кошиком.
    stats = next(v for k, v in redis.hashes.items() if k.startswith("api:stats:"))
    assert stats == {"ratelimit:lookup:blocked": 1}


async def test_owner_endpoints_need_the_internal_key() -> None:
    body = {"account": "serpapi", "period": "day", "limit": 5}
    async for _, client in _app_client(FakeRedis()):
        assert (await client.put("/ops/budgets", json=body)).status_code == 404  # ключа немає
    async for _, client in _app_client(FakeRedis(), internal_api_key=KEY):
        assert (await client.put("/ops/budgets", json=body)).status_code == 401
        wrong = {"x-internal-key": "x" * 32}
        assert (await client.put("/ops/budgets", json=body, headers=wrong)).status_code == 401
        bad = {**body, "account": "deepseek"}
        response = await client.put("/ops/budgets", json=bad, headers={"x-internal-key": KEY})
        assert response.status_code == 422


async def test_signed_in_user_gets_own_bucket_and_forged_token_does_not() -> None:
    async for app, client in _app_client(
        FakeRedis(), rate_limit_lookup_per_hour=1, rate_limit_account_multiplier=2
    ):
        good = {"authorization": "Bearer good"}
        forged = {"authorization": "Bearer forged"}
        codes = [
            (await client.get("/places/countries", headers=good)).status_code for _ in range(3)
        ]
        assert codes == [200, 200, 429]  # акаунт: ліміт × 2
        assert app.state.accounts.lookups == 1  # перевірка токена — з кешу Redis
        # Підроблений токен — кошик IP, а не новий кошик на кожен токен.
        assert (await client.get("/places/countries", headers=forged)).status_code == 200
        other = {"authorization": "Bearer forged-2"}
        assert (await client.get("/places/countries", headers=other)).status_code == 429


async def test_concurrent_searches_per_client_are_capped() -> None:
    redis = FakeRedis()
    async for _, client in _app_client(redis, max_concurrent_searches=1, internal_api_key=KEY):
        key = "cc:127.0.0.1"  # IP клієнта ASGITransport
        redis.store[key] = b"1"  # один пошук цього клієнта ще триває
        assert (await client.post("/flights/search", json=FLIGHT)).status_code == 429
        assert redis.store[key] == b"1"  # відмова не лишила лічильник завищеним
        redis.store[key] = b"0"
        assert (await client.post("/flights/search", json=FLIGHT)).status_code == 200
        assert redis.store[key] == b"0"  # після пошуку — назад


async def test_oversized_body_is_rejected() -> None:
    async for _, client in _app_client(FakeRedis()):
        big = {**FLIGHT, "padding": "x" * (1024 * 1024 + 1)}
        assert (await client.post("/flights/search", json=big)).status_code == 413

        async def stream() -> AsyncIterator[bytes]:
            for _ in range(20):
                yield b"x" * 64 * 1024

        # Без Content-Length (потік) — рахуємо байти.
        response = await client.post(
            "/flights/search", content=stream(), headers={"content-type": "application/json"}
        )
        assert response.status_code == 413


async def test_concurrency_cap_is_skipped_when_visitors_are_indistinguishable() -> None:
    """Без INTERNAL_API_KEY усі відвідувачі — один IP Vercel: не обмежуємо весь сайт."""
    redis = FakeRedis()
    async for _, client in _app_client(redis, max_concurrent_searches=1):
        redis.store["cc:127.0.0.1"] = b"5"
        assert (await client.post("/flights/search", json=FLIGHT)).status_code == 200
