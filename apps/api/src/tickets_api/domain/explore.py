"""Explore — пошук напрямків за бюджетом (ADR 0045). Без I/O.

Ціни — лише з кешованих джерел (Travelpayouts: «найдешевші квитки з міста будь-куди», без
квоти). Живого пошуку на кожен напрямок немає: перевірка — переходом у пошук рейсів чи поїздку.
Житло (режим `trip`) — лише для кількох найдешевших напрямків: це платні запити (ADR 0044).
"""

from datetime import date, timedelta
from typing import Annotated, Literal, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import (
    DEFAULT_CURRENCY,
    WEEKEND_MAX_NIGHTS,
    Currency,
    Iata,
    Money,
    Offer,
    _StrictInput,
    is_weekend_trip,
    stay_nights,
)
from tickets_api.domain.freshness import PriceFreshness

ExploreCategory = Literal["city", "sea", "mountains", "romance", "culture", "nightlife"]
Region = Literal[
    "europe", "middle_east", "africa", "asia", "north_america", "south_america", "oceania"
]
ExploreMode = Literal["flights", "trip"]
CountryCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")]
Lang = Literal["uk", "en"]

MAX_EXPLORE_ORIGINS = 3
MAX_EXPLORE_SPAN_DAYS = 92
"""Період вильоту — до трьох місяців: запит на кожен місяць, тож більше — зайві виклики."""
MAX_EXPLORE_NIGHTS = 30
MAX_EXPLORE_RESULTS = 60


class ExploreQuery(_StrictInput):
    origins: list[Iata] = Field(min_length=1, max_length=MAX_EXPLORE_ORIGINS)
    """Місто чи аеропорти вильоту; кожен — окремий запит до джерела."""
    country: CountryCode | None = None
    region: Region | None = None
    """Напрямок: країна, регіон або (обидва None) — будь-куди."""
    categories: list[ExploreCategory] = Field(default_factory=list, max_length=6)
    """Будь-яка з категорій (довідник напрямків); «море» — лише в сезон."""
    departure_date: date
    departure_until: date | None = None
    """None — точні дати (`return_date`); інакше виліт у будь-який день періоду."""
    return_date: date | None = None
    min_nights: int | None = Field(default=None, ge=1, le=MAX_EXPLORE_NIGHTS)
    max_nights: int | None = Field(default=None, ge=1, le=MAX_EXPLORE_NIGHTS)
    weekends: bool = False
    """Лише вихідні: виліт чт–сб, повернення сб–пн, до 4 ночей."""
    adults: int = Field(default=1, ge=1, le=9)
    """Кешовані ціни — за дорослого; дітей джерело не рахує (ADR 0013), тож лише дорослі."""
    budget: int | None = Field(default=None, ge=1, le=1_000_000)
    """Максимум за всіх: переліт (режим flights) або переліт + житло (trip), у валюті пошуку."""
    mode: ExploreMode = "flights"
    direct_only: bool = False
    currency: Currency = DEFAULT_CURRENCY
    lang: Lang = "uk"
    limit: int = Field(default=30, ge=1, le=MAX_EXPLORE_RESULTS)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.country is not None and self.region is not None:
            raise ValueError("країна або регіон — щось одне")
        if len(set(self.origins)) != len(self.origins):
            raise ValueError("аеропорти вильоту повторюються")
        if self.departure_until is None:
            if self.return_date is None:
                raise ValueError("точні дати — виліт і повернення")
            if self.return_date <= self.departure_date:
                raise ValueError("повернення має бути пізніше за виліт")
            if (self.return_date - self.departure_date).days > MAX_EXPLORE_NIGHTS:
                raise ValueError(f"не довше за {MAX_EXPLORE_NIGHTS} ночей")
        else:
            span = (self.departure_until - self.departure_date).days
            if not 0 <= span <= MAX_EXPLORE_SPAN_DAYS:
                raise ValueError(f"період вильоту — до {MAX_EXPLORE_SPAN_DAYS} днів")
            if self.return_date is not None:
                raise ValueError("у гнучкому пошуку тривалість задають ночі")
        if (self.min_nights is None) != (self.max_nights is None):
            raise ValueError("кількість ночей — від і до разом")
        if (self.min_nights or 0) > (self.max_nights or MAX_EXPLORE_NIGHTS):
            raise ValueError("мінімум ночей більший за максимум")
        return self

    @property
    def nights_range(self) -> tuple[int, int]:
        if self.min_nights is not None and self.max_nights is not None:
            low, high = self.min_nights, self.max_nights
        elif self.return_date is not None:
            low = high = (self.return_date - self.departure_date).days
        else:
            low, high = 1, MAX_EXPLORE_NIGHTS
        if self.weekends:
            high = min(high, WEEKEND_MAX_NIGHTS)
        return low, high

    @property
    def departure_window(self) -> tuple[date, date]:
        return self.departure_date, self.departure_until or self.departure_date

    @property
    def months(self) -> list[date]:
        """Перше число кожного місяця вильоту (точні дати — один день)."""
        start, end = self.departure_window
        months, current = [], start.replace(day=1)
        while current <= end:
            months.append(current)
            current = (current + timedelta(days=32)).replace(day=1)
        return months

    def fits(self, offer: Offer) -> bool:
        """Дати пропозиції — у вікні вильоту, ночей — у межах, вихідні — за днями тижня."""
        if offer.inbound is None:
            return False
        depart = offer.outbound.departure_at.date()
        back = offer.inbound.departure_at.date()
        start, end = self.departure_window
        if not start <= depart <= end:
            return False
        if self.departure_until is None and back != self.return_date:
            return False
        nights, _ = stay_nights(offer.outbound, offer.inbound)
        low, high = self.nights_range
        if self.departure_until is not None and not low <= nights <= high:
            return False
        if self.direct_only and offer.stops > 0:
            return False
        return not self.weekends or is_weekend_trip(depart, back)


class DestinationPhoto(BaseModel):
    url: str
    """Мініатюра з upload.wikimedia.org (довідник напрямків, скрипт оновлення)."""
    page: str
    """Стаття Вікіпедії — атрибуція фото."""


class ExploreStay(BaseModel):
    """Житло для напрямку (режим trip): вибір скорингу житла в межах залишку бюджету."""

    id: str
    source: str
    name: str
    rating: float | None
    total_price: Money
    currency: str
    taxes_included: bool | None
    image_url: str | None = None


StayStatus = Literal["ok", "not_checked", "none", "unsupported", "rate_limited", "error"]
"""not_checked — напрямок поза кількома найдешевшими (житло — платні запити);
none — житла в межах бюджету не знайдено."""


class ExploreDestination(BaseModel):
    code: str
    """Код міста (Travelpayouts віддає місто призначення)."""
    city_name: str
    country: str
    lat: float | None = None
    lon: float | None = None
    categories: list[ExploreCategory] = []
    photo: DestinationPhoto | None = None
    offer: Offer
    """Найдешевший переліт, що підходить під дати; ціна — за всіх дорослих."""
    nights: int
    nights_approximate: bool = False
    """Прибуття невідоме — ночі від дати вильоту (може бути на одну менше)."""
    freshness: PriceFreshness
    stay: ExploreStay | None = None
    stay_status: StayStatus | None = None
    """None — режим «лише авіаквитки»."""
    total: Money | None = None
    """Переліт + житло, коли житло знайдено (у валюті пошуку). Орієнтовно: ціни кешовані."""
