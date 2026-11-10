"""Порівняння варіантів поїздки (етап 4 розширення, ADR 0048) — лише код, жодної моделі.

- `differences` — конкретні відмінності одного варіанта від іншого: «дешевше на 35 €»,
  «прямий рейс замість пересадки», «на 6 год більше в місті», «рейтинг житла вищий на 0,6».
- `better_within_budget` — кращий за якістю варіант серед уже знайдених, що вкладається в бюджет
  (без бюджету — не дорожчий за поточний). Нових запитів до джерел немає.
- `recommendations` — до двох підказок після пошуку з реально знайдених комбінацій: інші дати
  помітно дешевші, більше часу в місті за майже ту саму ціну, краще житло за ту саму ціну.
"""

from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import Money
from tickets_api.domain.stays import Stay

DifferenceCode = Literal[
    "cheaper",
    "pricier",
    "direct",
    "fewer_stops",
    "more_stops",
    "faster",
    "slower",
    "more_city_time",
    "less_city_time",
    "earlier",
    "later",
    "higher_rating",
    "lower_rating",
    "closer",
    "farther",
]
AlternativeKind = Literal["better", "cheaper_dates", "more_city_time", "better_stay"]

MIN_PRICE_DIFF = Decimal(1)
MIN_TRAVEL_DIFF_MIN = 30
MIN_CITY_DIFF_MIN = 60
MIN_RATING_DIFF = Decimal("0.3")
MIN_DISTANCE_DIFF_KM = Decimal("0.5")
# Пороги рекомендацій: підказка має бути вартою уваги, а не шумом.
CHEAPER_DATES_MIN = Decimal(10)
CHEAPER_DATES_SHARE = Decimal("0.05")
MORE_CITY_MIN = 180
MORE_CITY_PRICE_SHARE = Decimal("1.05")
BETTER_STAY_RATING = Decimal("0.5")
BETTER_STAY_PRICE_SHARE = Decimal("1.03")
MAX_RECOMMENDATIONS = 2
UNKNOWN_MINUTES = 10**6


class Comparable(BaseModel):
    """Що порівнюємо в комбінації (поля `TripCombo`), щоб модуль не залежав від планувальника."""

    key: str
    offer_key: str
    stay_key: str
    stay_index: int
    money_total: Money
    unknown: int
    stops: int
    travel_min: int | None
    city_minutes: int | None
    full_nights: int
    check_in: date
    check_out: date


class TripDifference(BaseModel):
    code: DifferenceCode
    amount: Money | None = None
    minutes: int | None = None
    count: int | None = None
    rating: Money | None = None
    km: Money | None = None
    days: int | None = None


class TripAlternative(BaseModel):
    kind: AlternativeKind
    combo_key: str
    differences: list[TripDifference]


def differences(
    current: Comparable, current_stay: Stay, other: Comparable, other_stay: Stay
) -> list[TripDifference]:
    """Чим `other` відрізняється від `current`: спершу ціна, далі переліт, час у місті, житло."""
    out: list[TripDifference] = []
    price = other.money_total - current.money_total
    if abs(price) >= MIN_PRICE_DIFF:
        out.append(TripDifference(code="pricier" if price > 0 else "cheaper", amount=abs(price)))
    if other.stops == 0 and current.stops > 0:
        out.append(TripDifference(code="direct", count=current.stops))
    elif other.stops != current.stops:
        code: DifferenceCode = "fewer_stops" if other.stops < current.stops else "more_stops"
        out.append(TripDifference(code=code, count=abs(other.stops - current.stops)))
    if other.travel_min is not None and current.travel_min is not None:
        travel = other.travel_min - current.travel_min
        if abs(travel) >= MIN_TRAVEL_DIFF_MIN:
            out.append(
                TripDifference(code="slower" if travel > 0 else "faster", minutes=abs(travel))
            )
    shift = (other.check_in - current.check_in).days
    if shift:
        out.append(TripDifference(code="later" if shift > 0 else "earlier", days=abs(shift)))
    if other.city_minutes is not None and current.city_minutes is not None:
        city = other.city_minutes - current.city_minutes
        if abs(city) >= MIN_CITY_DIFF_MIN:
            code = "more_city_time" if city > 0 else "less_city_time"
            out.append(TripDifference(code=code, minutes=abs(city)))
    if other_stay.rating is not None and current_stay.rating is not None:
        rating = other_stay.rating - current_stay.rating
        if abs(rating) >= MIN_RATING_DIFF:
            code = "higher_rating" if rating > 0 else "lower_rating"
            out.append(TripDifference(code=code, rating=abs(rating)))
    near, far = other_stay.distance_to_center_km, current_stay.distance_to_center_km
    if near is not None and far is not None and abs(near - far) >= MIN_DISTANCE_DIFF_KM:
        out.append(TripDifference(code="closer" if near < far else "farther", km=abs(near - far)))
    return out


def _quality(c: Comparable, stay: Stay) -> tuple[int, int, Decimal, int, Decimal]:
    """Менше — краще: пересадки, повноцінні ночі, рейтинг, час у дорозі, відстань до центру."""
    return (
        c.stops,
        -c.full_nights,
        -(stay.rating if stay.rating is not None else Decimal(-1)),
        c.travel_min if c.travel_min is not None else UNKNOWN_MINUTES,
        stay.distance_to_center_km if stay.distance_to_center_km is not None else Decimal(999),
    )


def better_within_budget(
    current: Comparable,
    combos: Sequence[Comparable],
    stays: Sequence[Stay],
    budget: int | None,
) -> TripAlternative | None:
    """Найкращий за якістю варіант, кращий за поточний, у межах бюджету (без нього — не дорожчий
    за поточний). Варіант з більшою кількістю невідомих сум не пропонуємо."""
    limit = Decimal(budget) if budget is not None else current.money_total
    base = _quality(current, stays[current.stay_index])
    pool = [
        c
        for c in combos
        if c.key != current.key
        and c.money_total <= limit
        and c.unknown <= current.unknown
        and _quality(c, stays[c.stay_index]) < base
    ]
    if not pool:
        return None
    best = min(pool, key=lambda c: (_quality(c, stays[c.stay_index]), c.money_total))
    return _alternative("better", current, best, stays)


def recommendations(
    current: Comparable, combos: Sequence[Comparable], stays: Sequence[Stay]
) -> list[TripAlternative]:
    """До двох підказок з реально знайдених комбінацій (див. docstring модуля)."""
    others = [c for c in combos if c.key != current.key and c.unknown <= current.unknown]
    found: list[TripAlternative] = []
    saving_min = max(CHEAPER_DATES_MIN, current.money_total * CHEAPER_DATES_SHARE)
    dates = [
        c
        for c in others
        if (c.check_in, c.check_out) != (current.check_in, current.check_out)
        and current.money_total - c.money_total >= saving_min
    ]
    if dates:
        found.append(_alternative("cheaper_dates", current, min(dates, key=_price), stays))
    if current.city_minutes is not None:
        longer = [
            c
            for c in others
            if c.city_minutes is not None
            and c.city_minutes - current.city_minutes >= MORE_CITY_MIN
            and c.money_total <= current.money_total * MORE_CITY_PRICE_SHARE
        ]
        if longer:
            best = max(longer, key=lambda c: (c.city_minutes or 0, -c.money_total))
            found.append(_alternative("more_city_time", current, best, stays))
    rating = stays[current.stay_index].rating
    if rating is not None:
        nicer = [
            c
            for c in others
            if c.offer_key == current.offer_key
            and (r := stays[c.stay_index].rating) is not None
            and r - rating >= BETTER_STAY_RATING
            and c.money_total <= current.money_total * BETTER_STAY_PRICE_SHARE
        ]
        if nicer:
            best = max(nicer, key=lambda c: (stays[c.stay_index].rating or 0, -c.money_total))
            found.append(_alternative("better_stay", current, best, stays))
    unique: dict[str, TripAlternative] = {}
    for alt in found:
        unique.setdefault(alt.combo_key, alt)
    return list(unique.values())[:MAX_RECOMMENDATIONS]


def _alternative(
    kind: AlternativeKind, current: Comparable, other: Comparable, stays: Sequence[Stay]
) -> TripAlternative:
    return TripAlternative(
        kind=kind,
        combo_key=other.key,
        differences=differences(current, stays[current.stay_index], other, stays[other.stay_index]),
    )


def _price(c: Comparable) -> Decimal:
    return c.money_total
