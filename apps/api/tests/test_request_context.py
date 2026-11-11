"""Ідентифікатор запиту, заголовки безпеки й документація API (V3, етап 4)."""

from collections.abc import AsyncIterator
from typing import Any

import structlog
from asgi_lifespan import LifespanManager
from conftest import make_settings
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from structlog.testing import capture_logs
from tickets_api.main import create_app


async def _client(app: FastAPI | None = None, **settings: Any) -> AsyncIterator[AsyncClient]:
    app = app or create_app(make_settings(**settings))
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


async def test_request_id_is_kept_or_generated_and_returned() -> None:
    async for client in _client():
        given = await client.get("/health", headers={"x-request-id": "fra1::abc-123456"})
        assert given.headers["x-request-id"] == "fra1::abc-123456"
        assert given.headers["x-content-type-options"] == "nosniff"
        assert given.headers["cache-control"] == "no-store"

        # Чуже значення (пробіли, переноси, задовге) не потрапляє в логи — генеруємо своє.
        forged = await client.get("/health", headers={"x-request-id": "bad id\\ninjected"})
        assert len(forged.headers["x-request-id"]) == 32
        assert forged.headers["x-request-id"] != "bad id\\ninjected"


async def test_request_id_is_in_every_log_line_of_the_request() -> None:
    log = structlog.get_logger("test")
    app = create_app(make_settings())

    async def inside() -> dict[str, str]:
        log.info("inside")
        return {}

    app.add_api_route("/__log", inside)
    async for client in _client(app):
        with capture_logs(processors=[structlog.contextvars.merge_contextvars]) as logs:
            await client.get("/__log", headers={"x-request-id": "req-12345678"})
        assert {"event": "inside", "log_level": "info", "request_id": "req-12345678"} in logs


async def test_docs_are_hidden_in_production() -> None:
    async for client in _client(app_env="production"):
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert (await client.get(path)).status_code == 404
    async for client in _client():
        assert (await client.get("/openapi.json")).status_code == 200
