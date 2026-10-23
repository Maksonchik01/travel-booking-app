import os
from collections.abc import AsyncIterator
from typing import Any

import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from tickets_api.core.config import Settings
from tickets_api.main import create_app

# Порт 1 на localhost ніхто не слухає: з'єднання відхиляється миттєво.
UNREACHABLE_DB = "postgresql+asyncpg://u:p@127.0.0.1:1/none"
UNREACHABLE_REDIS = "redis://127.0.0.1:1/0"


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "app_env": "test",
        "database_url": UNREACHABLE_DB,
        "redis_url": UNREACHABLE_REDIS,
        "readiness_timeout_s": 1.0,
        "sentry_dsn": None,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


async def _client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """Клієнт без живих залежностей."""
    async for c in _client(create_app(make_settings())):
        yield c


@pytest.fixture
async def live_client() -> AsyncIterator[AsyncClient]:
    """Клієнт з реальними Postgres і Redis. Пропускається, якщо вони не задані."""
    db_url = os.environ.get("TEST_DATABASE_URL")
    redis_url = os.environ.get("TEST_REDIS_URL")
    if not db_url or not redis_url:
        pytest.skip("TEST_DATABASE_URL / TEST_REDIS_URL не задані")
    async for c in _client(create_app(make_settings(database_url=db_url, redis_url=redis_url))):
        yield c
