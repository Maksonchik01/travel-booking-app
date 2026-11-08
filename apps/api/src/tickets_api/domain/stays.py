"""Нормалізовані моделі житла. Спільні для всіх провайдерів, скорингу, API і UI.

Ціни — з податками й зборами (те, що гість реально заплатить), рейтинг — за шкалою 0–10.
Невідоме — None, а не «немає»: відстань, транспорт чи умови скасування провайдер може
не повідомити, і тоді UI та скоринг кажуть «невідомо».
"""

import math
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
StayKind = Literal["hotel", "apartment", "hostel", "guesthouse", "other"]
"""other — віли, будинки, кемпінги тощо: що джерело не відносить до основних категорій."""
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
    "balcony",
]
"""balcony — балкон або тераса."""
Prepayment = Literal["none", "required"]
MAX_ROOMS = 5


class Guests(_StrictInput):
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    children_ages: list[int] = Field(default_factory=list, max_length=8)
    """Вік кожної дитини (0–17), якщо тариф від нього залежить; порожньо — не вказано."""
    rooms: int = Field(default=1, ge=1, le=MAX_ROOMS)

    @model_validator(mode="after")
    def _ages(self) -> Self:
        if self.children_ages:
            if len(self.children_ages) != self.children:
                raise ValueError("вік — для кожної дитини")
            if any(not 0 <= age <= 17 for age in self.children_ages):
                raise ValueError("вік дитини — від 0 до 17")
        if self.rooms > self.adults + self.children:
            raise ValueError("кімнат більше, ніж гостей")
        return self


def normalize_rating(value: float | Decimal, scale_max: float) -> Decimal:
    """Оцінка джерела за його шкалою (5, 10, 100…) → 0–10 з одним знаком (для адаптерів)."""
    if scale_max <= 0 or not 0 <= float(value) <= scale_max:
        raise ValueError("оцінка поза шкалою джерела")
    return Decimal(str(round(float(value) / scale_max * 10, 1)))


class GeoPoint(_StrictInput):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class BoundingBox(_StrictInput):
    """Видима область карти («Шукати в цій області», модуль 6)."""

    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def _order(self) -> Self:
        if self.south >= self.north:
            raise ValueError("південна межа має бути нижче північної")
        return self

    def contains(self, lat: float, lon: float) -> bool:
        inside_lon = (
            self.west <= lon <= self.east
            if self.west <= self.east
            else lon >= self.west or lon <= self.east  # через 180-й меридіан
        )
        return self.south <= lat <= self.north and inside_lon


def distance_between(a: GeoPoint, lat: float, lon: float) -> float:
    """Відстань по великому колу, км (як у довіднику аеропортів)."""
    p1, p2 = math.radians(a.lat), math.radians(lat)
    dp, dl = p2 - p1, math.radians(lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


class StayFilters(_StrictInput):
    """Фільтри видачі: як і для перельотів, застосовуються після провайдерів."""

    min_price_per_night: int | None = Field(default=None, ge=1, le=100_000)
    max_price_per_night: int | None = Field(default=None, ge=1, le=100_000)
    """Бюджет на ніч з податками, у валюті пошуку."""
    min_total_price: int | None = Field(default=None, ge=1, le=1_000_000)
    max_total_price: int | None = Field(default=None, ge=1, le=1_000_000)
    """За все проживання з податками."""
    min_rating: float | None = Field(default=None, ge=0, le=10)
    """Рейтинг уже нормалізований до 0–10 адаптером джерела."""
    free_cancellation: bool = False
    breakfast_included: bool = False
    no_prepayment: bool = False
    pay_at_property: bool = False
    kinds: list[StayKind] = Field(default_factory=list)
    """Порожньо — будь-які."""
    amenities: list[Amenity] = Field(default_factory=list)
    """Усі обрані мають бути в об'єкта."""
    min_beds: int | None = Field(default=None, ge=1, le=20)
    max_distance_center_km: float | None = Field(default=None, gt=0, le=100)
    districts: list[str] = Field(default_factory=list, max_length=20)
    near: GeoPoint | None = None
    """Пошук біля точки (координати) — разом з `radius_km`."""
    near_airport: Iata | None = None
    """Біля аеропорту: точку за кодом бере сервіс із довідника (геокодування адрес немає)."""
    radius_km: float | None = Field(default=None, gt=0, le=100)
    bbox: BoundingBox | None = None
    """Лише об'єкти в цій області карти; без координат — не потрапляють (місце невідоме)."""

    def matches(self, stay: "Stay") -> bool:
        if self.max_price_per_night is not None and stay.price_per_night > Decimal(
            self.max_price_per_night
        ):
            return False
        if self.min_rating is not None and (stay.rating is None or stay.rating < self.min_rating):
            return False
        if self.min_price_per_night is not None and stay.price_per_night < self.min_price_per_night:
            return False
        if self.min_total_price is not None and stay.total_price < self.min_total_price:
            return False
        if self.max_total_price is not None and stay.total_price > self.max_total_price:
            return False
        # Умови: фільтр вимагає ПІДТВЕРДЖЕНОГО значення — невідоме не проходить, бо людина
        # явно обрала «сніданок включено», а не «можливо включено».
        if self.free_cancellation and stay.cancellation != "free":
            return False
        if self.breakfast_included and stay.breakfast_included is not True:
            return False
        if self.no_prepayment and stay.prepayment != "none":
            return False
        if self.pay_at_property and stay.pay_at_property is not True:
            return False
        if self.amenities and not set(self.amenities) <= set(stay.amenities):
            return False
        if self.min_beds is not None and (stay.beds is None or stay.beds < self.min_beds):
            return False
        if self.max_distance_center_km is not None and (
            stay.distance_to_center_km is None
            or stay.distance_to_center_km > Decimal(str(self.max_distance_center_km))
        ):
            return False
        if self.districts and stay.district not in self.districts:
            return False
        if self.near is not None and self.radius_km is not None:
            if stay.latitude is None or stay.longitude is None:
                return False
            if distance_between(self.near, stay.latitude, stay.longitude) > self.radius_km:
                return False
        if self.bbox is not None and (
            stay.latitude is None
            or stay.longitude is None
            or not self.bbox.contains(stay.latitude, stay.longitude)
        ):
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
    breakfast_included: bool | None = None
    """None — невідомо."""
    prepayment: Prepayment | None = None
    """none — без передоплати; required — потрібна; None — невідомо."""
    pay_at_property: bool | None = None
    beds: int | None = Field(default=None, ge=1, le=20)
    """Ліжок у запропонованому номері (номерах); None — невідомо."""
    rooms: int = Field(default=1, ge=1, le=MAX_ROOMS)
    """Скільки номерів у ціні (як у запиті)."""
    district: str | None = None
    address: str | None = None
    """Адреса від джерела; None — лише район (вигаданої адреси не підставляємо)."""
    image_url: str | None = None
    """Фото від джерела (https); None — UI фото не показує."""
    deep_link: str | None = None
    seller: str | None = None
    sellers: int | None = Field(default=None, ge=1)
    """Скільки продавців пропонують об'єкт, якщо джерело вміє порівняння (`rates`); None — ні."""
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
    airports: list[str] = []
    """Аеропорти міста — для фільтра «біля аеропорту»."""
