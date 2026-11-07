import os
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from flight_fakes import day, offers_for
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from tickets_api.db.models import PriceObservation
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.repositories.price_history import (
    calendar_rows,
    offer_rows,
    route_price_stats,
    save_observations,
)

pytestmark = pytest.mark.integration

SOURCE = "it-test"


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    async with create_sessionmaker(engine)() as s:
        await s.execute(delete(PriceObservation).where(PriceObservation.source == SOURCE))
        await s.commit()
        yield s
        await s.execute(delete(PriceObservation).where(PriceObservation.source == SOURCE))
        await s.commit()
    await engine.dispose()


async def count(session: AsyncSession) -> int:
    stmt = select(func.count()).where(PriceObservation.source == SOURCE)
    return (await session.execute(stmt)).scalar_one()


async def test_offers_are_saved_once_even_if_served_again_from_cache(
    session: AsyncSession,
) -> None:
    rows = offer_rows("WAW", "LIS", offers_for(SOURCE, [100, 120]))

    assert await save_observations(session, rows) == 2
    assert await save_observations(session, rows) == 0  # повтор з кешу — той самий collected_at
    assert await count(session) == 2

    saved = (
        await session.execute(
            select(PriceObservation).where(PriceObservation.source == SOURCE).limit(1)
        )
    ).scalar_one()
    assert (saved.origin, saved.destination, saved.currency, saved.kind) == (
        "WAW",
        "LIS",
        "EUR",
        "offer",
    )
    assert saved.collected_at == datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


async def test_new_collection_of_same_price_is_a_new_observation(session: AsyncSession) -> None:
    first = offer_rows("WAW", "LIS", offers_for(SOURCE, [100]))
    later = [{**first[0], "collected_at": datetime(2026, 10, 27, 9, 0, tzinfo=UTC)}]

    await save_observations(session, first)
    await save_observations(session, later)

    assert await count(session) == 2


async def test_calendar_rows_are_saved(session: AsyncSession) -> None:
    rows = calendar_rows("waw", "lis", [day(SOURCE, 1, 99), day(SOURCE, 2, 120)])

    assert await save_observations(session, rows) == 2


async def test_stats_compare_only_the_same_party_and_cabin(session: AsyncSession) -> None:
    # Маршрут-заглушка, щоб не перетинатися з іншими даними в БД.
    single = offer_rows("ZZA", "ZZB", offers_for(SOURCE, [100, 120]))
    family = offer_rows(
        "ZZA",
        "ZZB",
        [o.model_copy(update={"id": f"fam-{o.id}"}) for o in offers_for(SOURCE, [900])],
        party="2a1c0l0s",
    )
    await save_observations(session, single + family)

    stats = await route_price_stats(
        session,
        origin="ZZA",
        destination="ZZB",
        departure=date(2026, 11, 10),
        round_trip=False,
        currency="EUR",
        best_price=Decimal(100),
    )

    assert stats is not None
    assert (stats.sample_size, stats.median) == (2, Decimal(110))
