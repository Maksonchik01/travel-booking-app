"""Запис кожної отриманої ціни в історію (маршрут, дата, ціна, валюта, джерело, час збору)."""

from collections.abc import Sequence
from typing import Any

import structlog
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import PriceObservation
from tickets_api.domain.flights import CalendarDay, Offer

log = structlog.get_logger(__name__)

BATCH_SIZE = 1000


def offer_rows(origin: str, destination: str, offers: Sequence[Offer]) -> list[dict[str, Any]]:
    """Маршрут — коди із запиту, а не фактичні аеропорти: WAW-запит може дати рейс з WMI."""
    return [
        {
            "origin": origin.upper(),
            "destination": destination.upper(),
            "departure_date": o.outbound.departure_at.date(),
            "return_date": o.inbound.departure_at.date() if o.inbound else None,
            "price": o.price,
            "currency": o.currency,
            "stops": o.stops,
            "source": o.source,
            "kind": "offer",
            "observation_key": o.id,
            "collected_at": o.collected_at,
            "found_at": o.found_at,
            "found_on": o.found_on,
        }
        for o in offers
    ]


def calendar_rows(
    origin: str, destination: str, days: Sequence[CalendarDay]
) -> list[dict[str, Any]]:
    return [
        {
            "origin": origin.upper(),
            "destination": destination.upper(),
            "departure_date": d.date,
            "return_date": None,
            "price": d.price,
            "currency": d.currency,
            "stops": d.stops,
            "source": d.source,
            "kind": "calendar_min",
            "observation_key": f"cal:{origin.upper()}{destination.upper()}:{d.date.isoformat()}",
            "collected_at": d.collected_at,
            "found_at": d.found_at,
            "found_on": d.found_on,
        }
        for d in days
    ]


async def save_observations(session: AsyncSession, rows: list[dict[str, Any]]) -> int:
    """Пакетна вставка; повтори (та сама ціна з кешу) тихо пропускаються. Повертає к-сть нових."""
    inserted = 0
    # Postgres обмежує кількість параметрів у запиті (32767), тож пишемо пачками.
    for start in range(0, len(rows), BATCH_SIZE):
        stmt = (
            insert(PriceObservation)
            .values(rows[start : start + BATCH_SIZE])
            .on_conflict_do_nothing(index_elements=["source", "observation_key", "collected_at"])
            .returning(PriceObservation.id)
        )
        inserted += len((await session.execute(stmt)).all())
    await session.commit()
    return inserted


class PriceHistoryRecorder:
    """Пише історію у власній сесії. Збій БД не ламає пошук: логуємо й ідемо далі."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def record(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            async with self._sessionmaker() as session:
                inserted = await save_observations(session, rows)
        except Exception as exc:  # історія — побічний ефект, не причина 500
            log.warning("price_history.write_failed", rows=len(rows), error=type(exc).__name__)
            return
        log.debug("price_history.recorded", rows=len(rows), inserted=inserted)
