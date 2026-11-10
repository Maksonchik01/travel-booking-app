"""Графік історії цін (етап 6, ADR 0050) — на справжньому Postgres (TEST_DATABASE_URL)."""

import os
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from tickets_api.db.models import PriceObservation, StayPriceObservation
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.repositories.price_series import flight_series, stay_series

SOURCE = "it-series"
# Вигаданий маршрут: локальна база може мати справжні спостереження популярних маршрутів.
ORIGIN, DESTINATION = "QQA", "QQB"
TODAY = date(2026, 11, 11)
DEPART, BACK = date(2026, 12, 5), date(2026, 12, 8)


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    async with create_sessionmaker(engine)() as s:
        await _clean(s)
        yield s
        await _clean(s)
    await engine.dispose()


async def _clean(s: AsyncSession) -> None:
    await s.execute(delete(PriceObservation).where(PriceObservation.source == SOURCE))
    await s.execute(delete(StayPriceObservation).where(StayPriceObservation.source == SOURCE))
    await s.commit()


def flight(days_ago: int, price: int, key: str, **kw: Any) -> PriceObservation:
    seen = datetime.combine(TODAY - timedelta(days=days_ago), datetime.min.time(), UTC)
    fields: dict[str, Any] = {
        "origin": ORIGIN,
        "destination": DESTINATION,
        "departure_date": DEPART,
        "return_date": BACK,
        "price": Decimal(price),
        "currency": "EUR",
        "stops": 0,
        "source": SOURCE,
        "kind": "offer",
        "party": "1a0c0l0s",
        "cabin": "economy",
        "observation_key": key,
        "collected_at": seen + timedelta(hours=1),
        "found_at": None,
        "found_on": None,
    }
    fields.update(kw)
    return PriceObservation(**fields)


@pytest.mark.integration
async def test_flight_series_is_min_per_day_for_same_trip(session: AsyncSession) -> None:
    session.add_all(
        [
            flight(5, 210, "a"),
            flight(5, 190, "b"),  # той самий день — мінімум
            flight(3, 180, "c"),
            # день знаходження з кешованого джерела важить більше за день отримання
            flight(1, 175, "d", found_on=TODAY - timedelta(days=2)),
            flight(1, 99, "e", return_date=None),  # інший тип поїздки — не та сама ціна
            flight(1, 99, "f", party="2a0c0l0s"),  # інший склад
            flight(1, 99, "g", currency="PLN"),
            flight(200, 99, "h"),  # старше за 90 днів
        ]
    )
    await session.commit()

    series = await flight_series(
        session,
        origin=ORIGIN,
        destination=DESTINATION,
        departure=DEPART,
        return_date=BACK,
        party="1a0c0l0s",
        cabin="economy",
        currency="EUR",
        today=TODAY,
    )

    assert [(p.day, p.price, p.observations) for p in series.points] == [
        (TODAY - timedelta(days=5), Decimal(190), 2),
        (TODAY - timedelta(days=3), Decimal(180), 1),
        (TODAY - timedelta(days=2), Decimal(175), 1),
    ]
    assert series.enough is True


@pytest.mark.integration
async def test_stay_series_uses_listing_price_only(session: AsyncSession) -> None:
    def stay(days_ago: int, total: int, seller: str = "") -> StayPriceObservation:
        return StayPriceObservation(
            city="LIS",
            check_in=DEPART,
            check_out=BACK,
            guests=2,
            stay_id="h1",
            kind="hotel",
            price_per_night=Decimal(total) / 3,
            total_price=Decimal(total),
            currency="EUR",
            source=SOURCE,
            seller=seller,
            room="",
            collected_at=datetime.combine(
                TODAY - timedelta(days=days_ago), datetime.min.time(), UTC
            ),
        )

    session.add_all([stay(4, 300), stay(2, 280), stay(2, 150, seller="Booking.com")])
    await session.commit()

    series = await stay_series(
        session,
        source=SOURCE,
        stay_id="h1",
        check_in=DEPART,
        check_out=BACK,
        guests=2,
        currency="EUR",
        today=TODAY,
    )

    assert [p.price for p in series.points] == [Decimal(300), Decimal(280)]
    assert series.enough is False  # два дні — ще не графік


async def test_history_endpoints_without_database_are_empty(client: AsyncClient) -> None:
    flights = await client.get(
        "/flights/history",
        params={"origin": "WAW", "destination": "LIS", "departure": "2026-12-05"},
    )
    stays = await client.get(
        "/stays/history",
        params={"source": "mock", "stay_id": "x", "in": "2026-12-05", "out": "2026-12-08"},
    )

    assert flights.json() == {"currency": "EUR", "points": [], "enough": False}
    assert stays.json() == {"currency": "EUR", "points": [], "enough": False}
