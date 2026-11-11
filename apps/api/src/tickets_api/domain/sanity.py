"""Неправдоподібні пропозиції джерел (V3, етап 6, ADR 0059). Без I/O.

Дані провайдерів недовірені: помилка розбору чи збій джерела може дати рейс, що прилітає
раніше, ніж вилітає, повернення до прибуття туди, податки більші за ціну, житло не на ті ночі.
Такі пропозиції не показуємо й не рахуємо в скорингу; сервіс пише в лог лише коди й кількість.

Пороги навмисно широкі: правило ловить явну помилку даних, а не незвичну, але реальну поїздку
(довга пересадка, нічний рейс, зміна дати через пояс).
"""

from collections import Counter
from collections.abc import Callable, Iterable
from datetime import timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Protocol

import structlog

from tickets_api.domain.flights import FlightQuery, Leg, Offer
from tickets_api.domain.stays import Stay, StayQuery

log = structlog.get_logger(__name__)


class _Sourced(Protocol):
    @property
    def source(self) -> str: ...


MIN_LEG_MIN = 15
"""Найкоротший реальний переліт — ~15–20 хв; менше — помилка тривалості."""
MAX_LEG_MIN = 72 * 60
"""Найдовший маршрут із пересадками рідко перевищує 2 доби; 3 доби — явна помилка."""
DATE_SLACK_DAYS = 1
"""Дата вильоту — у місцевому часі аеропорту; запас на день через пояси й нічні рейси."""
STAY_PRICE_RATIO = Decimal(2)
"""Сума за всі ночі проти «ціна за ніч × ночі»: розбіжність понад удвічі — помилка даних."""


def _leg_problems(leg: Leg) -> list[str]:
    problems = []
    if leg.arrival_at is not None and leg.arrival_at <= leg.departure_at:
        problems.append("arrival_before_departure")
    if leg.duration_min is not None and not MIN_LEG_MIN <= leg.duration_min <= MAX_LEG_MIN:
        problems.append("implausible_duration")
    for segment in leg.segments or []:
        if segment.arrival_at <= segment.departure_at:
            problems.append("segment_arrival_before_departure")
            break
    for previous, following in pairwise(leg.segments or []):
        if following.departure_at < previous.arrival_at:
            problems.append("segments_out_of_order")
            break
    return problems


def offer_problems(offer: Offer, query: FlightQuery) -> list[str]:
    """Коди проблем пропозиції; порожньо — правдоподібна."""
    problems = _leg_problems(offer.outbound)
    if offer.inbound is not None:
        problems += _leg_problems(offer.inbound)
        reached = offer.outbound.arrival_at or offer.outbound.departure_at
        if offer.inbound.departure_at <= reached:
            problems.append("return_before_arrival")
    if offer.taxes is not None and offer.taxes > offer.price:
        problems.append("taxes_exceed_price")
    first = query.departure_date - timedelta(days=query.flex_days + DATE_SLACK_DAYS)
    last = (query.departure_until or query.departure_date) + timedelta(
        days=query.flex_days + DATE_SLACK_DAYS
    )
    if not first <= offer.outbound.departure_at.date() <= last:
        problems.append("date_outside_query")
    return problems


def stay_problems(stay: Stay, query: StayQuery) -> list[str]:
    problems = []
    if stay.nights != query.nights:
        problems.append("nights_mismatch")
    expected = stay.price_per_night * stay.nights
    if (
        stay.total_price * STAY_PRICE_RATIO < expected
        or stay.total_price > expected * STAY_PRICE_RATIO
    ):
        problems.append("price_inconsistent")
    return problems


def drop_implausible[T: _Sourced](
    items: Iterable[T], problems: Callable[[T], list[str]], kind: str
) -> list[T]:
    """Лише правдоподібні; відкинуте — у лог: вид, джерело й коди (без маршрутів і цін)."""
    kept: list[T] = []
    dropped: Counter[str] = Counter()
    for item in items:
        found = problems(item)
        if found:
            dropped.update(f"{item.source}:{code}" for code in found)
        else:
            kept.append(item)
    if dropped:
        log.warning("search.implausible_dropped", kind=kind, problems=dict(dropped))
    return kept
