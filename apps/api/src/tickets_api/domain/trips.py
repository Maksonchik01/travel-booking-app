"""Поїздка «переліт туди-назад + житло на ці дати». Без I/O — лише моделі запиту.

Дати — точні (виліт і повернення) або гнучкі: ±дні чи період вильоту, а тривалість —
кількість ночей на місці від дати ПРИЛЬОТУ (як у пошуку перельотів, ADR 0016).
Побажання до перельоту (прямий, багаж, клас) і житла (фільтри видачі) — обов'язкові умови.
"""

from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from tickets_api.domain.flights import (
    DEFAULT_CURRENCY,
    MAX_EXTRA_AIRPORTS,
    MAX_PERIOD_DAYS,
    BaggageNeed,
    Cabin,
    Currency,
    FlightPreferences,
    Iata,
    Money,
    _StrictInput,
)
from tickets_api.domain.stays import MAX_NIGHTS, StayFilters, StayPreferences, StayProfile
from tickets_api.scoring.config import Profile

TripProfile = Literal["budget", "balanced", "comfort"]
"""Що важливіше в поїздці. Мапиться на профілі скорингу перельотів і житла."""
MAX_TRIP_FLEX_DAYS = 3
MAX_EXTRAS = 5
StayKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]{1,32}:[\w.-]{1,128}$")]
"""`source:id` об'єкта житла."""
OfferKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]{1,32}:[\w.-]{1,64}$")]
"""`source:id` пропозиції перельоту."""
TRIP_NEARBY_KM = 150
"""«Сусідні аеропорти»: як у формі пошуку перельотів."""

FLIGHT_PROFILE: dict[TripProfile, Profile] = {
    "budget": "budget",
    "balanced": "balanced",
    "comfort": "time_is_money",
}
STAY_PROFILE: dict[TripProfile, StayProfile] = {
    "budget": "budget",
    "balanced": "balanced",
    "comfort": "center",
}


class TripExtra(_StrictInput):
    """Витрата, яку людина додала сама (екскурсії, страховка…) — орієнтовна, її оцінка."""

    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    amount: Money = Field(ge=0, le=Decimal(100_000))


class TripPreferences(_StrictInput):
    """Уподобання з профілю (модуль 14.4): м'які — лише в оцінку перельоту й житла."""

    flights: FlightPreferences | None = None
    stays: StayPreferences | None = None


class TripQuery(_StrictInput):
    origin: Iata
    destination: Iata
    origin_also: list[Iata] = Field(default_factory=list, max_length=MAX_EXTRA_AIRPORTS)
    destination_also: list[Iata] = Field(default_factory=list, max_length=MAX_EXTRA_AIRPORTS)
    """Ще аеропорти вильоту й прибуття (модуль 2); житло — у місті `destination`."""
    departure_date: date
    return_date: date | None = None
    """Точна дата повернення. Без неї — потрібна тривалість (`min_nights`/`max_nights`)."""
    flex_days: int = Field(default=0, ge=0, le=MAX_TRIP_FLEX_DAYS)
    departure_until: date | None = None
    """Гнучкий період: виліт у будь-який день [departure_date, departure_until]."""
    min_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    max_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    """Тривалість: ночей на місці — від дати прильоту до дати вильоту назад."""
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    """І для житла, і для перельоту: ціну дітей рахує джерело (ADR 0013)."""
    direct_only: bool = False
    weekends: bool = False
    """Лише вихідні (модуль 3): з періодом вильоту — чт–сб → сб–пн."""
    nearby: bool = False
    """Ще й сусідні аеропорти (до TRIP_NEARBY_KM) з обох боків."""
    cabin: Cabin = "economy"
    baggage: BaggageNeed = "none"
    """Багаж на кожного: доплата входить у бюджет, тариф без такого багажу — не підходить."""
    stay_filters: StayFilters = StayFilters()
    """Побажання до житла (рейтинг, скасування, сніданок, тип, відстань) — обов'язкові."""
    profile: TripProfile = "balanced"
    budget_total: int | None = Field(default=None, ge=1, le=1_000_000)
    """Бюджет на всю поїздку (переліт, багаж, житло, власні витрати), у валюті пошуку."""
    extras: list[TripExtra] = Field(default_factory=list, max_length=MAX_EXTRAS)
    airport_road: Money | None = Field(default=None, ge=0, le=Decimal(10_000))
    """Дорога до аеропорту вильоту й назад на всіх (етап 4) — вручну: даних про транспорт немає.
    Окремо від бронювання, у сумі — орієнтовно."""
    currency: Currency = DEFAULT_CURRENCY
    stay: StayKey | None = None
    """Обране житло («Додати до поїздки», модуль 7; заміна житла, 8b) — ключ `source:id`:
    планувальник бере його в кожне вікно дат, де воно доступне, а де ні — звичайний вибір."""
    flight: OfferKey | None = None
    """Обраний рейс (заміна перельоту, модуль 8b): якщо пошук його знову дав — це «Ваша
    поїздка», житло перевіряється на його дати; немає — чесно кажемо й підбираємо самі."""
    preferences: TripPreferences | None = None
    """М'які уподобання з профілю; не обов'язкові, як `stay_filters`."""

    @model_validator(mode="after")
    def _route_and_dates(self) -> Self:
        if {self.origin, *self.origin_also} & {self.destination, *self.destination_also}:
            raise ValueError("місто вильоту й призначення мають відрізнятися")
        if self.departure_until is not None:
            if self.flex_days:
                raise ValueError("період і ±дні разом не задаються")
            span = (self.departure_until - self.departure_date).days
            if not 0 <= span <= MAX_PERIOD_DAYS:
                raise ValueError(f"період — від дати вильоту, до {MAX_PERIOD_DAYS} днів")
        if (self.min_nights is None) != (self.max_nights is None):
            raise ValueError("тривалість — від і до разом")
        if self.min_nights is not None and self.max_nights is not None:
            if self.min_nights > self.max_nights:
                raise ValueError("мінімум ночей більший за максимум")
        elif self.return_date is None:
            raise ValueError("потрібна дата повернення або тривалість поїздки")
        if self.return_date is not None:
            if self.return_date <= self.departure_date:
                raise ValueError("повернення має бути пізніше за виліт")
            if (self.return_date - self.departure_date).days > MAX_NIGHTS:
                raise ValueError(f"поїздка не довша за {MAX_NIGHTS} ночей")
        return self

    @property
    def nights_range(self) -> tuple[int, int] | None:
        if self.min_nights is None or self.max_nights is None:
            return None
        return self.min_nights, self.max_nights

    @property
    def flight_return_date(self) -> date:
        """Повернення для запиту перельотів: точне або виліт + мінімум ночей (ADR 0016)."""
        if self.return_date is not None:
            return self.return_date
        return self.departure_date + timedelta(days=self.min_nights or 1)
