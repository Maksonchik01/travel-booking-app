import pytest
from httpx import AsyncClient
from tickets_api import __version__


async def test_health_is_ok_without_dependencies(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


async def test_ready_degrades_when_dependencies_are_down(client: AsyncClient) -> None:
    response = await client.get("/health/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["database"]["status"] == "error"
    assert body["checks"]["redis"]["status"] == "error"
    assert body["checks"]["database"]["error"]


@pytest.mark.integration
async def test_ready_is_ok_with_live_dependencies(live_client: AsyncClient) -> None:
    response = await live_client.get("/health/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"]["database"]["status"] == "ok"
    assert body["checks"]["redis"]["status"] == "ok"
