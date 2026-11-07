import os

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from tickets_api.db.models import OutboundClick
from tickets_api.db.session import create_engine, create_sessionmaker

CLICK = {"kind": "flight", "source": "travelpayouts", "host": "www.aviasales.com"}


@pytest.mark.parametrize(
    "patch",
    [
        {"kind": "hotel"},
        {"source": "Travel Payouts"},
        {"host": "https://www.aviasales.com"},
        {"host": "evil.example/path"},
        {"host": "localhost"},
    ],
)
async def test_click_rejects_bad_fields(client: AsyncClient, patch: dict[str, str]) -> None:
    response = await client.post("/outbound/clicks", json={**CLICK, **patch})
    assert response.status_code == 422


async def test_click_without_database_is_503_not_500(client: AsyncClient) -> None:
    response = await client.post("/outbound/clicks", json=CLICK)
    assert response.status_code == 503


@pytest.mark.integration
async def test_click_is_recorded(live_client: AsyncClient) -> None:
    engine = create_engine(os.environ["TEST_DATABASE_URL"])
    sessionmaker = create_sessionmaker(engine)

    async def count() -> int:
        async with sessionmaker() as session:
            return int((await session.execute(select(func.count(OutboundClick.id)))).scalar_one())

    before = await count()
    response = await live_client.post("/outbound/clicks", json=CLICK)
    assert response.status_code == 204
    assert await count() == before + 1
    await engine.dispose()
