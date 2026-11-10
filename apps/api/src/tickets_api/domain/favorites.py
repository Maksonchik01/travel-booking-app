"""«В обране» (модуль 7; 10a — три категорії): структурований знімок на момент збереження.
Без I/O.

Категорії: житло, авіаквитки, готові поїздки. Зберігаємо параметри пропозиції (рядок URL
пошуку, ідентифікатор, дати) і час отримання ціни — не лише ціну: «Повторити пошук» дає
актуальну, а ціна знімка — історична, UI так її й підписує.
"""

from datetime import date, datetime
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import Currency, Iata, Money, _StrictInput
from tickets_api.domain.saved_trips import TripSnapshot
from tickets_api.domain.stays import MAX_NIGHTS, StayKind
from tickets_api.domain.trips import TripQuery

FavoriteKind = Literal["stay", "flight", "trip", "destination"]
PHOTO_HOST = "https://upload.wikimedia.org/"
MAX_FAVORITES = 200
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class FavoriteStay(_StrictInput):
    source: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]{1,32}$")]
    stay_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    name: Text
    kind: StayKind
    city: Iata
    district: Annotated[str, StringConstraints(max_length=100)] | None = None
    rating: float | None = Field(default=None, ge=0, le=10)
    review_count: int = Field(default=0, ge=0)
    price_per_night: Money = Field(gt=0)
    total_price: Money = Field(gt=0)
    currency: Currency
    check_in: date
    check_out: date
    price_at: AwareDatetime
    """Коли джерело дало цю ціну (не коли збережено)."""
    params: Annotated[
        str, StringConstraints(min_length=1, max_length=500, pattern=r"^[\w%=&.,+:-]+$")
    ]
    """Рядок URL пошуку житла — «Відкрити пошук» повторює його з актуальними цінами."""

    @model_validator(mode="after")
    def _dates(self) -> Self:
        nights = (self.check_out - self.check_in).days
        if not 1 <= nights <= MAX_NIGHTS:
            raise ValueError("некоректні дати проживання")
        return self

    @property
    def item_key(self) -> str:
        return f"{self.source}:{self.stay_id}|{self.check_in}|{self.check_out}"


class FavoriteFlight(_StrictInput):
    """Авіаквиток: рейс (ідентифікатор джерела), маршрут, час, умови й ціна з часом отримання."""

    source: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]{1,32}$")]
    offer_id: Annotated[str, StringConstraints(pattern=r"^[\w.-]{1,64}$")]
    origin: Iata
    destination: Iata
    departure_at: datetime
    """Місцевий час аеропорту, як у пропозиції."""
    arrival_at: datetime | None = None
    return_departure_at: datetime | None = None
    return_arrival_at: datetime | None = None
    stops: int = Field(ge=0, le=10)
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    airlines: list[Annotated[str, StringConstraints(max_length=3)]] = Field(max_length=8)
    passengers: int = Field(default=1, ge=1, le=9)
    price: Money = Field(gt=0)
    currency: Currency
    price_status: Literal["live", "cached"]
    price_at: AwareDatetime
    params: Annotated[
        str, StringConstraints(min_length=1, max_length=500, pattern=r"^[\w%=&.,+:-]+$")
    ]
    """Рядок URL пошуку перельотів — «Повторити пошук»."""

    @property
    def item_key(self) -> str:
        return f"{self.source}:{self.offer_id}"


class FavoriteTrip(_StrictInput):
    """Готова поїздка: запит з вибором рейсу й житла + знімок (як «Мої поїздки», без статусу)."""

    title: Text
    query: TripQuery
    snapshot: TripSnapshot

    @property
    def item_key(self) -> str:
        return f"trip|{self.query.flight}|{self.query.stay}|{self.snapshot.check_in}"


class FavoriteDestination(_StrictInput):
    """Напрямок з Explore (етап 7, ADR 0051): місто, дати, ціна перельоту з часом отримання."""

    code: Iata
    city: Text
    country: Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")] | None = None
    depart: date
    back: date
    nights: int = Field(ge=0, le=MAX_NIGHTS)
    price: Money = Field(gt=0)
    """Переліт (або переліт + житло, якщо `with_stay`) — кешована ціна."""
    with_stay: bool = False
    currency: Currency
    price_at: AwareDatetime
    photo_url: Annotated[str, StringConstraints(max_length=500)] | None = None
    params: Annotated[
        str, StringConstraints(min_length=1, max_length=500, pattern=r"^[\w%=&.,+:-]+$")
    ]
    """Рядок URL пошуку Explore — «Повторити пошук»."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.back < self.depart:
            raise ValueError("некоректні дати")
        if self.photo_url is not None and not self.photo_url.startswith(PHOTO_HOST):
            raise ValueError("фото — лише з довідника напрямків")
        return self

    @property
    def item_key(self) -> str:
        return f"dest|{self.code}|{self.depart}|{self.back}"


class FavoriteBody(_StrictInput):
    kind: FavoriteKind = "stay"
    stay: FavoriteStay | None = None
    flight: FavoriteFlight | None = None
    trip: FavoriteTrip | None = None
    destination: FavoriteDestination | None = None

    @model_validator(mode="after")
    def _one(self) -> Self:
        if getattr(self, self.kind) is None:
            raise ValueError("дані обраного — для його категорії")
        return self

    @property
    def item(self) -> "FavoriteStay | FavoriteFlight | FavoriteTrip | FavoriteDestination":
        value = {
            "stay": self.stay,
            "flight": self.flight,
            "trip": self.trip,
            "destination": self.destination,
        }[self.kind]
        if value is None:  # валідатор уже не пропустить — для типів
            raise ValueError("дані обраного — для його категорії")
        return value


class FavoritesImport(_StrictInput):
    """Обране гостя з браузера — до акаунта після входу (повтори пропускаються)."""

    items: list[FavoriteBody] = Field(max_length=MAX_FAVORITES)


class FavoriteOut(BaseModel):
    id: str
    kind: FavoriteKind
    item_key: str
    stay: FavoriteStay | None = None
    flight: FavoriteFlight | None = None
    trip: FavoriteTrip | None = None
    destination: FavoriteDestination | None = None
    created_at: datetime
