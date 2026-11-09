"""Збережені поїздки (модуль 8c): запит (з обраним рейсом і житлом) + знімок на момент
збереження. Без I/O.

Ціни в знімку — історичні: UI підписує їх часом збереження, а актуальні дає лише «Оновити
ціни» (`POST /trips/refresh`), який заново складає ту саму поїздку.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, Field, StringConstraints

from tickets_api.domain.flights import Currency, Iata, Money, _StrictInput
from tickets_api.domain.stays import Cancellation, StayKind
from tickets_api.domain.trips import TripQuery

MAX_SAVED_TRIPS = 50
TripStatus = Literal["draft", "planned", "archived"]
"""Чернетка / запланована / архівна. «Заброньованої» немає: бронювання SkyPack не бачить."""
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class TripFlightSnapshot(_StrictInput):
    origin: Iata
    destination: Iata
    departure_at: datetime
    """Виліт туди (місцевий час аеропорту, як у пропозиції)."""
    arrival_at: datetime | None = None
    return_departure_at: datetime
    return_arrival_at: datetime | None = None
    stops: int = Field(ge=0, le=10)
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    """Туди й назад разом; None — невідомо."""
    airlines: list[Annotated[str, StringConstraints(max_length=3)]] = Field(max_length=8)
    price: Money = Field(gt=0)
    price_status: Literal["live", "cached"]


class TripStaySnapshot(_StrictInput):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    kind: StayKind
    rating: float | None = Field(default=None, ge=0, le=10)
    review_count: int = Field(default=0, ge=0)
    district: Annotated[str, StringConstraints(max_length=100)] | None = None
    distance_to_center_km: float | None = Field(default=None, ge=0, le=1_000)
    cancellation: Cancellation | None = None
    total_price: Money = Field(gt=0)


class TripSnapshot(_StrictInput):
    """Що людина бачила, коли зберегла поїздку."""

    money_total: Money = Field(ge=0)
    confirmed: Money = Field(ge=0)
    approximate: Money = Field(ge=0)
    unknown: int = Field(ge=0, le=20)
    currency: Currency
    check_in: date
    check_out: date
    nights: int = Field(ge=1, le=30)
    flight: TripFlightSnapshot
    stay: TripStaySnapshot
    priced_at: AwareDatetime
    """Коли отримано ціни (рендер сторінки поїздки)."""


class SavedTripBody(_StrictInput):
    title: Title
    query: TripQuery
    """З `flight` і `stay` — «Відкрити» показує саме цю конфігурацію."""
    snapshot: TripSnapshot
    status: TripStatus = "draft"


class SavedTripPatch(_StrictInput):
    """Назва та/або статус (без зміни конфігурації й знімка)."""

    title: Title | None = None
    status: TripStatus | None = None


class SavedTripsImport(_StrictInput):
    """Поїздки гостя з браузера — до акаунта після входу."""

    items: list[SavedTripBody] = Field(max_length=MAX_SAVED_TRIPS)


class SavedTripOut(BaseModel):
    id: str
    title: str
    status: TripStatus = "draft"
    query: TripQuery
    snapshot: TripSnapshot
    created_at: datetime
    updated_at: datetime
    share_token: str | None = None
    """Публічне посилання ввімкнено (модуль 20.2) — `/shared/trip/<token>`; None — приватна."""


class SharedTrip(BaseModel):
    """Публічний перегляд поїздки (модуль 20.2): лише сама поїздка. Без власника, назви, статусу,
    бюджету, уподобань і підписів власних витрат — там може бути щось особисте."""

    query: TripQuery
    snapshot: TripSnapshot


def public_query(query: TripQuery) -> TripQuery:
    """Запит для чужих очей: маршрут, дати, люди, обрані рейс і житло, умови пошуку."""
    return query.model_copy(update={"budget_total": None, "extras": [], "preferences": None})


class TripRefreshRequest(_StrictInput):
    """«Оновити ціни»: та сама поїздка заново + сума зі знімка для порівняння."""

    query: TripQuery
    saved_total: Money = Field(ge=0)
