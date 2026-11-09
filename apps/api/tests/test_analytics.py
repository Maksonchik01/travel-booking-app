"""Модуль 19: анонімні події — лише перелічені назви й короткі мітки; зведення й 90 днів."""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.db.models import AnalyticsEvent
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.analytics import EventIn, results_bucket
from tickets_api.repositories.analytics import prune_events, record_event
from tickets_api.services.ops import usage_summary


def test_event_accepts_only_known_names_and_short_labels() -> None:
    event = EventIn(name="search_succeeded", props={"mode": "flights", "results": "6-20"})
    assert event.props == {"mode": "flights", "results": "6-20"}
    with pytest.raises(ValidationError):
        EventIn.model_validate({"name": "page_view"})
    with pytest.raises(ValidationError):  # вільний текст (а з ним — персональні дані) — ні
        EventIn(name="search_failed", props={"reason": "Warsaw to Lisbon for Ivan"})
    with pytest.raises(ValidationError):  # невідома мітка — ні
        EventIn.model_validate({"name": "outbound", "props": {"email": "x"}})


@pytest.mark.parametrize(("count", "bucket"), [(0, "0"), (3, "1-5"), (20, "6-20"), (99, "21+")])
def test_results_are_bucketed(count: int, bucket: str) -> None:
    assert results_bucket(count) == bucket


async def test_endpoint_rejects_unknown_events(client: AsyncClient) -> None:
    response = await client.post("/events", json={"name": "page_view"})
    assert response.status_code == 422


# --- проти Postgres -----------------------------------------------------------------------------


@pytest.fixture
async def sessionmaker() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    maker = create_sessionmaker(engine)
    async with maker() as session, session.begin():
        await session.execute(delete(AnalyticsEvent))
    yield maker
    async with maker() as session, session.begin():
        await session.execute(delete(AnalyticsEvent))
    await engine.dispose()


@pytest.mark.integration
async def test_summary_counts_events_and_search_funnel(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    for event in (
        EventIn(name="search_started", props={"mode": "flights"}),
        EventIn(name="search_started", props={"mode": "flights"}),
        EventIn(name="search_succeeded", props={"mode": "flights", "results": "1-5"}),
        EventIn(name="search_empty", props={"mode": "flights"}),
        EventIn(name="outbound", props={"kind": "flight", "source": "serpapi"}),
    ):
        await record_event(sessionmaker, event)

    usage = await usage_summary(sessionmaker, datetime.now(UTC) + timedelta(minutes=1))

    assert usage.events_7d["search_started"] == 2
    assert usage.events_7d["outbound"] == 1
    assert usage.searches_7d["flights"] == {"started": 2, "succeeded": 1, "empty": 1, "failed": 0}
    async with sessionmaker() as session:
        stored = (await session.scalars(select(AnalyticsEvent.props))).all()
    assert all(p is None or len(p) < 100 for p in stored)  # лише мітки, нічого більше


@pytest.mark.integration
async def test_events_are_kept_90_days(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    await record_event(sessionmaker, EventIn(name="trip_saved"))
    await record_event(sessionmaker, EventIn(name="trip_saved"))
    now = datetime.now(UTC)
    async with sessionmaker() as session, session.begin():
        first = await session.scalar(select(AnalyticsEvent.id).order_by(AnalyticsEvent.id))
        await session.execute(
            update(AnalyticsEvent)
            .where(AnalyticsEvent.id == first)
            .values(created_at=now - timedelta(days=91))
        )

    assert await prune_events(sessionmaker, now) == 1
    async with sessionmaker() as session:
        assert len((await session.scalars(select(AnalyticsEvent.id))).all()) == 1
