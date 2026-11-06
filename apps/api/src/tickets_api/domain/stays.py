"""Нормалізовані моделі житла. Спільні для всіх провайдерів, скорингу, API і UI.

Ціни — з податками й зборами (те, що гість реально заплатить), рейтинг — за шкалою 0–10.
Невідоме — None, а не «немає»: відстань, транспорт чи умови скасування провайдер може
не повідомити, і тоді UI та скоринг кажуть «невідомо».
"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, Field, PlainSerializer, model_validator

from tickets_api.domain.flights import (
    DEFAULT_CURRENCY,
    Currency,
    Iata,
    Money,
    _Frozen,
    _StrictInput,
)

MAX_NIGHTS = 30
# Рейтинг і відстані всередині — Decimal; у JSON — число (як Money), бо так зручніше UI.
Number = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]
StayKind = Literal["hotel", "apartment", "hostel", "guesthouse"]
Cancellation = Literal["free", "partial", "non_refundable"]
StayProfile = Literal["budget", "balanced", "center"]
Amenity = Literal[
    "wifi",
    "breakfast",
    "parking",
    "pool",
    "gym",
    "kitchen",
    "air_conditioning",
    "spa",
    "pets",
    "airport_shuttle",
]


class Guests(_StrictInput):
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)


class StayFilters(_StrictInput):
    """Фільтри видачі: як і для перельотів, застосовуються після провайдерів."""

    max_price_per_night: int | None = Field(default=None, ge=1, le=100_000)
    """Бюджет на ніч з податками, у валюті пошуку."""
    min_rating: float | None = Field(default=None, ge=0, le=10)
    free_cancellation: bool = False
    kinds: list[StayKind] = Field(default_factory=list)
    """Порожньо — будь-які."""

    def matches(self, stay: "Stay") -> bool:
        if self.max_price_per_night is not None and stay.price_per_night > Decimal(
            self.max_price_per_night
        ):
            return False
        if self.min_rating is not None and (stay.rating is None or stay.rating < self.min_rating):
            return False
        if self.free_cancellation and stay.cancellation != "free":
            return False
        return not self.kinds or stay.kind in self.kinds


class StayQuery(_StrictInput):
    city: Iata
    """Код міста (LIS) або аеропорту (WAW → Варшава)."""
    check_in: date
    check_out: date
    guests: Guests = Guests()
    currency: Currency = DEFAULT_CURRENCY
    profile: StayProfile = "balanced"
    """Що важливіше: ціна, баланс чи близькість до центру — ваги value-score."""
    filters: StayFilters = StayFilters()

    @model_validator(mode="after")
    def _dates(self) -> Self:
        if self.check_out <= self.check_in:
            raise ValueError("дата виїзду має бути пізніше за дату заїзду")
        if (self.check_out - self.check_in).days > MAX_NIGHTS:
            raise ValueError(f"не більше {MAX_NIGHTS} ночей")
        return self

    @property
    def nights(self) -> int:
        return (self.check_out - self.check_in).days


class Stay(_Frozen):
    id: str
    """Стабільний ідентифікатор у межах джерела."""
    source: str
    name: str
    kind: StayKind
    stars: int | None = Field(default=None, ge=1, le=5)
    price_per_night: Money = Field(gt=0)
    """Середня ціна за ніч з податками й зборами, за весь номер (усіх гостей)."""
    total_price: Money = Field(gt=0)
    """За всі ночі з податками й зборами."""
    currency: Currency
    nights: int = Field(ge=1, le=MAX_NIGHTS)
    rating: Number | None = Field(default=None, ge=0, le=10)
    """Шкала 0–10. None — оцінок немає."""
    review_count: int = Field(default=0, ge=0)
    latitude: float | None = None
    longitude: float | None = None
    distance_to_center_km: Number | None = Field(default=None, ge=0)
    distance_to_transit_m: int | None = Field(default=None, ge=0)
    """До найближчої зупинки громадського транспорту."""
    cancellation: Cancellation | None = None
    """None — умови невідомі."""
    free_cancellation_until: date | None = None
    amenities: list[Amenity] = Field(default_factory=list)
    district: str | None = None
    image_url: str | None = None
    deep_link: str | None = None
    seller: str | None = None
    collected_at: AwareDatetime
    found_at: AwareDatetime | None = None


# Поле StayReview.date затінює тип date всередині класу.
_Date = date


class StayReview(_Frozen):
    """Відгук — НЕДОВІРЕНИЙ текст: його можна лише підсумовувати, не виконувати."""

    text: str
    rating: Number | None = Field(default=None, ge=0, le=10)
    date: _Date
    lang: str = "uk"


class StayPlace(BaseModel):
    """Місто пошуку (для заголовка й відстаней)."""

    code: str
    name: str
    country: str
