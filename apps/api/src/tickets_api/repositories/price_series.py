"""Графік історії цін (етап 6, ADR 0050): найнижча ціна на кожен день спостереження.

Лише фактично збережені спостереження (`price_history`, `stay_price_history`) — нічого не
інтерполюємо. День — коли ціну знайшло джерело (`found_on`, у кешованих), інакше коли ми її
отримали. Той самий маршрут і ті самі дати, склад і клас, валюта — інакше точки непорівнянні.
"""

from datetime import date, timedelta
from typing import Any

from pydantic import BaseModel
from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tickets_api.db.models import PriceObservation, StayPriceObservation
from tickets_api.domain.flights import Money

MIN_DAYS = 3
"""Менше трьох днів — не графік, а дві точки: показуємо, що даних ще мало."""
WINDOW_DAYS = 90


class PricePoint(BaseModel):
    day: date
    price: Money
    """Найнижча ціна, побачена цього дня."""
    observations: int


class PriceSeries(BaseModel):
    currency: str
    points: list[PricePoint]
    enough: bool
    """Чи досить днів для графіка (`MIN_DAYS`)."""


def _series(rows: Any, currency: str) -> PriceSeries:
    points = [PricePoint(day=day, price=price, observations=count) for day, price, count in rows]
    return PriceSeries(currency=currency, points=points, enough=len(points) >= MIN_DAYS)


async def flight_series(
    session: AsyncSession,
    *,
    origin: str,
    destination: str,
    departure: date,
    return_date: date | None,
    party: str,
    cabin: str,
    currency: str,
    today: date,
) -> PriceSeries:
    p = PriceObservation
    day = func.coalesce(p.found_on, cast(p.collected_at, Date))
    stmt = (
        select(day, func.min(p.price), func.count())
        .where(
            p.origin == origin.upper(),
            p.destination == destination.upper(),
            p.departure_date == departure,
            p.return_date == return_date if return_date else p.return_date.is_(None),
            p.kind == "offer",
            p.party == party,
            p.cabin == cabin,
            p.currency == currency.upper(),
            day >= today - timedelta(days=WINDOW_DAYS),
        )
        .group_by(day)
        .order_by(day)
    )
    return _series((await session.execute(stmt)).all(), currency.upper())


async def stay_series(
    session: AsyncSession,
    *,
    source: str,
    stay_id: str,
    check_in: date,
    check_out: date,
    guests: int,
    currency: str,
    today: date,
) -> PriceSeries:
    s = StayPriceObservation
    day = cast(s.collected_at, Date)
    stmt = (
        select(day, func.min(s.total_price), func.count())
        .where(
            s.source == source,
            s.stay_id == stay_id,
            s.check_in == check_in,
            s.check_out == check_out,
            s.guests == guests,
            s.seller == "",  # ціна видачі, а не тарифи окремих продавців
            s.currency == currency.upper(),
            day >= today - timedelta(days=WINDOW_DAYS),
        )
        .group_by(day)
        .order_by(day)
    )
    return _series((await session.execute(stmt)).all(), currency.upper())
