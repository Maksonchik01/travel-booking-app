import json
from datetime import datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import AnalyticsEvent
from tickets_api.domain.analytics import RETENTION_DAYS, EventIn


async def record_event(sessionmaker: async_sessionmaker[AsyncSession], event: EventIn) -> None:
    props = json.dumps(event.props, sort_keys=True, separators=(",", ":")) if event.props else None
    async with sessionmaker() as session:
        session.add(AnalyticsEvent(name=event.name, props=props))
        await session.commit()


async def prune_events(sessionmaker: async_sessionmaker[AsyncSession], now: datetime) -> int:
    """Події старші за RETENTION_DAYS — геть (зберігаємо не довше, ніж треба для трендів)."""
    async with sessionmaker() as session, session.begin():
        result = await session.execute(
            delete(AnalyticsEvent).where(
                AnalyticsEvent.created_at < now - timedelta(days=RETENTION_DAYS)
            )
        )
    return int(result.rowcount)  # type: ignore[attr-defined]
