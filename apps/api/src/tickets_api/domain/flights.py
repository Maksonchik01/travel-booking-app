"""Нормалізовані моделі перельотів. Спільні для всіх провайдерів, скорингу, API і UI."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    StringConstraints,
    computed_field,
    model_validator,
)

Iata = Annotated[str, StringConstraints(pattern=r"^[A-Za-z]{3}$"), AfterValidator(str.upper)]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Za-z]{3}$"), AfterValidator(str.upper)]
# Гроші всередині — Decimal (без похибок float); у JSON — число, бо так зручніше UI.
Money = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]

MAX_FLEX_DAYS = 7
MAX_NEARBY_RADIUS_KM = 300
DEFAULT_CURRENCY = "EUR"


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True)


class _StrictInput(_Frozen):
    """Вхідні дані від клієнта: невідомі поля — помилка, а не тиха ігноровка."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class Passengers(_StrictInput):
    adults: int = Field(default=1, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    infants: int = Field(default=0, ge=0, le=8)

    @model_validator(mode="after")
    def _infants_need_adults(self) -> Self:
        if self.infants > self.adults:
            raise ValueError("немовлят не може бути більше, ніж дорослих")
        if self.adults + self.children > 9:
            raise ValueError("не більше 9 місць (дорослі + діти)")
        return self


DeparturePeriod = Literal["night", "morning", "afternoon", "evening"]
DEPARTURE_PERIOD_HOURS: dict[DeparturePeriod, range] = {
    "night": range(0, 6),
    "morning": range(6, 12),
    "afternoon": range(12, 18),
    "evening": range(18, 24),
}
AirlineCode = Annotated[
    str, StringConstraints(pattern=r"^[A-Za-z0-9]{2}$"), AfterValidator(str.upper)
]


class OfferFilters(_StrictInput):
    """Фільтри видачі. Застосовуються ПІСЛЯ провайдерів: до запиту й кешу не входять.

    Невідоме значення (тривалість, авіакомпанія) не відсікає пропозицію — як і в
    скорингу, «невідомо» не означає «погано» (ADR 0004).
    """

    max_stops: int | None = Field(default=None, ge=0, le=3)
    """Пересадок в одному напрямку, не більше."""
    airlines: list[AirlineCode] = Field(default_factory=list, max_length=20)
    """Порожньо — будь-які. Інакше всі перевізники маршруту мають бути серед обраних."""
    departure_periods: list[DeparturePeriod] = Field(default_factory=list)
    """Частина доби вильоту ТУДИ за місцевим часом аеропорту. Порожньо — будь-яка."""
    max_duration_hours: int | None = Field(default=None, ge=1, le=72)
    """Найдовший напрямок, не довше."""

    def matches(self, offer: "Offer") -> bool:
        legs = [offer.outbound, *([offer.inbound] if offer.inbound else [])]
        if self.max_stops is not None and any(leg.stops > self.max_stops for leg in legs):
            return False
        if self.airlines and offer.airlines and not set(offer.airlines) <= set(self.airlines):
            return False
        hour = offer.outbound.departure_at.hour
        if self.departure_periods and not any(
            hour in DEPARTURE_PERIOD_HOURS[p] for p in self.departure_periods
        ):
            return False
        if self.max_duration_hours is not None:
            limit = self.max_duration_hours * 60
            if any(leg.duration_min is not None and leg.duration_min > limit for leg in legs):
                return False
        return True


class FlightQuery(_StrictInput):
    origin: Iata
    destination: Iata
    departure_date: date
    return_date: date | None = None
    flex_days: int = Field(default=0, ge=0, le=MAX_FLEX_DAYS)
    passengers: Passengers = Passengers()
    direct_only: bool = False
    currency: Currency = DEFAULT_CURRENCY
    profile: Literal["budget", "balanced", "time_is_money"] = "balanced"
    """Вплив на скоринг (вагу часу й пересадок), не на запит до провайдерів."""
    origin_radius_km: int = Field(default=0, ge=0, le=MAX_NEARBY_RADIUS_KM)
    """0 — лише обраний аеропорт (чи аеропорти міста); >0 — ще й сусідні в цьому радіусі."""
    destination_radius_km: int = Field(default=0, ge=0, le=MAX_NEARBY_RADIUS_KM)
    filters: OfferFilters = OfferFilters()
    """Як і `profile`, впливає лише на видачу, не на запит до провайдерів."""

    @model_validator(mode="after")
    def _check_route_and_dates(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("пункти вильоту й прибуття збігаються")
        if self.return_date is not None and self.return_date < self.departure_date:
            raise ValueError("дата повернення раніша за дату вильоту")
        return self

    @property
    def departure_window(self) -> tuple[date, date]:
        delta = timedelta(days=self.flex_days)
        return self.departure_date - delta, self.departure_date + delta

    @property
    def return_window(self) -> tuple[date, date] | None:
        if self.return_date is None:
            return None
        delta = timedelta(days=self.flex_days)
        return self.return_date - delta, self.return_date + delta


class Segment(_Frozen):
    origin: Iata
    destination: Iata
    departure_at: AwareDatetime
    arrival_at: AwareDatetime
    carrier: str
    flight_number: str
    duration_min: int = Field(ge=0)


class Layover(_Frozen):
    airport: Iata
    duration_min: int = Field(ge=0)
    overnight: bool
    """Пересадка зачіпає нічні години (00:00–06:00) у аеропорту пересадки."""
    self_transfer: bool | None
    """Окремі квитки: багаж і стиковка — відповідальність пасажира. None — невідомо."""


class Leg(_Frozen):
    """Один напрямок подорожі (туди або назад)."""

    origin: Iata
    destination: Iata
    departure_at: AwareDatetime
    arrival_at: AwareDatetime | None = None
    duration_min: int | None = Field(default=None, ge=0)
    stops: int = Field(ge=0)
    segments: list[Segment] | None = None
    """None — провайдер не надає посегментних даних (див. Offer.details_level)."""
    layovers: list[Layover] | None = None
    """None — деталі пересадок невідомі; [] — пересадок немає."""
    flight_number: str | None = None
    """Номер першого рейсу, якщо провайдер дає лише його."""

    @model_validator(mode="after")
    def _consistent_details(self) -> Self:
        if self.layovers is not None and len(self.layovers) != self.stops:
            raise ValueError("кількість пересадок не збігається з layovers")
        if self.segments is not None and len(self.segments) != self.stops + 1:
            raise ValueError("кількість сегментів має бути stops + 1")
        return self


class Offer(_Frozen):
    id: str
    """Стабільний ідентифікатор у межах джерела (однаковий для тієї самої пропозиції)."""
    source: str
    price: Money = Field(gt=0)
    """Ціна за одного дорослого пасажира."""
    currency: Currency
    outbound: Leg
    inbound: Leg | None = None
    airlines: list[str]
    details_level: Literal["full", "summary"]
    """full — відомі сегменти й пересадки; summary — лише кількість пересадок і тривалість."""
    baggage_included: bool | None = None
    """None — провайдер не повідомляє умови багажу."""
    collected_at: AwareDatetime
    """Коли ми отримали цю ціну від провайдера."""
    found_at: AwareDatetime | None = None
    """Коли провайдер зафіксував ціну (для кешованих джерел); None — невідомо."""
    found_on: date | None = None
    """День, коли провайдер зафіксував ціну, якщо відомий лише день (без часу)."""
    expires_at: AwareDatetime | None = None
    deep_link: str | None = None
    seller: str | None = None
    """Хто продає квиток (агенція чи авіакомпанія), якщо провайдер повідомляє."""
    reported_total_duration_min: int | None = Field(default=None, ge=0)
    """Загальний час у дорозі від провайдера — коли його не розкласти по напрямках."""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def stops(self) -> int:
        return self.outbound.stops + (self.inbound.stops if self.inbound else 0)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_duration_min(self) -> int | None:
        legs = [self.outbound, *([self.inbound] if self.inbound else [])]
        if any(leg.duration_min is None for leg in legs):
            return self.reported_total_duration_min
        return sum(leg.duration_min or 0 for leg in legs)


# Поле CalendarDay.date затінює тип date всередині класу.
_Date = date


class CalendarDay(_Frozen):
    """Найнижча відома ціна на конкретну дату вильоту."""

    date: date
    price: Money = Field(gt=0)
    currency: Currency
    stops: int | None = Field(default=None, ge=0)
    airline: str | None = None
    source: str
    collected_at: AwareDatetime
    found_at: AwareDatetime | None = None
    found_on: _Date | None = None
