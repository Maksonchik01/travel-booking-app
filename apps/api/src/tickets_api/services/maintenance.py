"""Обслуговування БД (модуль 16): прибирання того, що вже нікому не потрібне. Запускає воркер.

Прострочені сесії входу й одноразові токени з листів не дають доступу (сервіс їх відкидає),
але лежали б вічно — видаляємо (GDPR: не зберігати довше, ніж треба).
"""

from collections.abc import Callable
from datetime import UTC, datetime

import structlog
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import AuthToken, UserSession
from tickets_api.repositories.analytics import prune_events

log = structlog.get_logger(__name__)


async def prune_expired(
    sessionmaker: async_sessionmaker[AsyncSession],
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> int:
    """Видалити прострочені сесії й токени та події аналітики старші за 90 днів.
    Повертає, скільки рядків прибрано."""
    now = clock()
    async with sessionmaker() as session, session.begin():
        sessions = await session.execute(delete(UserSession).where(UserSession.expires_at < now))
        tokens = await session.execute(delete(AuthToken).where(AuthToken.expires_at < now))
    events = await prune_events(sessionmaker, now)
    removed = sessions.rowcount + tokens.rowcount + events  # type: ignore[attr-defined]
    log.info("maintenance.pruned", sessions=sessions.rowcount, tokens=tokens.rowcount)  # type: ignore[attr-defined]
    return int(removed)
