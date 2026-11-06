"""Запис історії цін житла (як price_history для перельотів)."""

from collections.abc import Sequence
from typing import Any

import structlog
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import StayPriceObservation
from tickets_api.domain.stays import Stay, StayQuery

log = structlog.get_logger(__name__)

BATCH_SIZE = 1000
CONFLICT_COLUMNS = ["source", "stay_id", "check_in", "check_out", "guests", "collected_at"]


def stay_rows(query: StayQuery, stays: Sequence[Stay]) -> list[dict[str, Any]]:
    """Місто — з ЗАПИТУ (як і маршрут перельотів): ключ для статистики цін міста."""
    guests = query.guests.adults + query.guests.children
    return [
        {
            "city": query.city,
            "check_in": query.check_in,
            "check_out": query.check_out,
            "guests": guests,
            "stay_id": s.id,
            "kind": s.kind,
            "price_per_night": s.price_per_night,
            "total_price": s.total_price,
            "currency": s.currency,
            "source": s.source,
            "collected_at": s.collected_at,
        }
        for s in stays
    ]


async def save_stay_observations(session: AsyncSession, rows: list[dict[str, Any]]) -> int:
    """Пакетна вставка; повтори (та сама ціна з кешу) тихо пропускаються."""
    inserted = 0
    for start in range(0, len(rows), BATCH_SIZE):
        stmt = (
            insert(StayPriceObservation)
            .values(rows[start : start + BATCH_SIZE])
            .on_conflict_do_nothing(index_elements=CONFLICT_COLUMNS)
            .returning(StayPriceObservation.id)
        )
        inserted += len((await session.execute(stmt)).all())
    await session.commit()
    return inserted


class StayPriceHistoryRecorder:
    """Пише історію у власній сесії. Збій БД не ламає пошук: логуємо й ідемо далі."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def record(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            async with self._sessionmaker() as session:
                inserted = await save_stay_observations(session, rows)
        except Exception as exc:  # історія — побічний ефект, не причина 500
            log.warning("stay_price_history.write_failed", rows=len(rows), error=type(exc).__name__)
            return
        log.debug("stay_price_history.recorded", rows=len(rows), inserted=inserted)
