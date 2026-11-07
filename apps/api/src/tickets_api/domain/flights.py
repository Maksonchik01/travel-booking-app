"""Нормалізовані моделі перельотів. Спільні для всіх провайдерів, скорингу, API і UI."""

from datetime import date, datetime, timedelta
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
MAX_PERIOD_DAYS = 62
"""Найдовший період «найдешевші дати» (два місяці): більше — забагато кандидатів і запитів."""
MAX_CHECK_DATES = 4
MAX_NIGHTS = 30
MAX_NEARBY_RADIUS_KM = 300
DEFAULT_CURRENCY = "EUR"


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True)


class _StrictInput(_Frozen):
    """Вхідні дані від клієнта: невідомі поля — помилка, а не тиха ігноровка."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class DatePair(_StrictInput):
    departure: date
    return_date: date | None = None


class Passengers(_StrictInput):
    """Склад пасажирів. Ціну за весь склад рахує джерело (ADR 0013), ми тариф не множимо."""

    adults: int = Field(default=1, ge=1, le=9)
    """12 років і старші."""
    children: int = Field(default=0, ge=0, le=8)
    """2–11 років."""
    infants: int = Field(default=0, ge=0, le=8)
    """До 2 років, на руках у дорослого (без окремого місця)."""
    infants_in_seat: int = Field(default=0, ge=0, le=8)
    """До 2 років, з окремим місцем."""

    @model_validator(mode="after")
    def _infants_need_adults(self) -> Self:
        if self.infants > self.adults:
            raise ValueError("немовлят на руках не може бути більше, ніж дорослих")
        if self.infants + self.infants_in_seat > 2 * self.adults:
            raise ValueError("не більше двох немовлят на одного дорослого")
        if self.total > 9:
            raise ValueError("не більше 9 пасажирів")
        return self

    @property
    def total(self) -> int:
        return self.adults + self.children + self.infants + self.infants_in_seat

    @property
    def seated(self) -> int:
        """Скільки людей займають крісла (без немовлят на руках) — для скорингу часу."""
        return self.adults + self.children + self.infants_in_seat

    @property
    def adults_only(self) -> bool:
        return self.children == 0 and self.infants == 0 and self.infants_in_seat == 0

    @property
    def code(self) -> str:
        """Компактний ключ складу для історії цін: 2a1c1l0s."""
        return f"{self.adults}a{self.children}c{self.infants}l{self.infants_in_seat}s"


Cabin = Literal["economy", "premium_economy", "business", "first"]

BaggageNeed = Literal["none", "personal_item", "carry_on", "checked", "checked_extra"]
"""Що пасажир бере з собою (кожен): від «нічого» до двох зареєстрованих валіз."""
BagKind = Literal["personal_item", "carry_on", "checked", "checked_extra"]
BAGS_FOR_NEED: dict[BaggageNeed, tuple[BagKind, ...]] = {
    "none": (),
    "personal_item": ("personal_item",),
    "carry_on": ("personal_item", "carry_on"),
    "checked": ("personal_item", "checked"),
    "checked_extra": ("personal_item", "checked", "checked_extra"),
}


DeparturePeriod = Literal["night", "morning", "afternoon", "evening"]
"""Частина доби за місцевим часом аеропорту (ТЗ): ранок 05–12, день 12–17, вечір 17–22,
ніч 22–05. Назва історична — так само для прибуття."""
DEPARTURE_PERIOD_HOURS: dict[DeparturePeriod, tuple[int, int]] = {
    "night": (22, 5),
    "morning": (5, 12),
    "afternoon": (12, 17),
    "evening": (17, 22),
}


class HourRange(_StrictInput):
    """Власний діапазон годин [start, end) за місцевим часом; end < start — через північ."""

    start: int = Field(ge=0, le=23)
    end: int = Field(ge=0, le=24)

    @model_validator(mode="after")
    def _not_empty(self) -> Self:
        if self.start == self.end % 24:
            raise ValueError("порожній діапазон годин")
        return self

    def contains(self, hour: int) -> bool:
        return _in_hours(hour, self.start, self.end)


def _in_hours(hour: int, start: int, end: int) -> bool:
    return start <= hour < end if start < end else hour >= start or hour < end


def _time_ok(at: datetime | None, periods: list[DeparturePeriod], hours: HourRange | None) -> bool:
    """Обрані частини доби АБО власний діапазон. Невідомий час фільтр не відсікає (ADR 0004)."""
    if at is None or (not periods and hours is None):
        return True
    h = at.hour
    return any(_in_hours(h, *DEPARTURE_PERIOD_HOURS[p]) for p in periods) or (
        hours is not None and hours.contains(h)
    )


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
    excluded_airlines: list[AirlineCode] = Field(default_factory=list, max_length=20)
    """Жоден перевізник маршруту не з цього списку."""
    departure_periods: list[DeparturePeriod] = Field(default_factory=list)
    """Частина доби вильоту ТУДИ за місцевим часом аеропорту. Порожньо — будь-яка."""
    departure_hours: HourRange | None = None
    arrival_periods: list[DeparturePeriod] = Field(default_factory=list)
    """Прибуття ТУДИ."""
    arrival_hours: HourRange | None = None
    return_departure_periods: list[DeparturePeriod] = Field(default_factory=list)
    return_departure_hours: HourRange | None = None
    return_arrival_periods: list[DeparturePeriod] = Field(default_factory=list)
    return_arrival_hours: HourRange | None = None
    max_duration_hours: int | None = Field(default=None, ge=1, le=72)
    """Найдовший напрямок, не довше."""
    max_layover_hours: int | None = Field(default=None, ge=1, le=48)
    """Жодна пересадка не довша."""
    min_layover_min: int | None = Field(default=None, ge=0, le=720)
    """Звичайна пересадка (один квиток) — не коротша."""
    min_self_transfer_min: int | None = Field(default=None, ge=0, le=1440)
    """Пересадка на окремих квитках (self-transfer) — не коротша: багаж і стиковка на вас."""
    max_price: int | None = Field(default=None, ge=1, le=100_000)
    """Ціна на одного пасажира в цілих одиницях валюти, не більше. Бюджет з розбору — сюди."""
    max_total_price: int | None = Field(default=None, ge=1, le=1_000_000)
    """Ціна за всіх пасажирів разом, не більше."""

    def _layovers_ok(self, leg: "Leg") -> bool:
        """Невідомі пересадки (None) не відсікаємо; self_transfer=None — як звичайна."""
        for lay in leg.layovers or []:
            if (
                self.max_layover_hours is not None
                and lay.duration_min > self.max_layover_hours * 60
            ):
                return False
            limit = self.min_self_transfer_min if lay.self_transfer else self.min_layover_min
            if limit is not None and lay.duration_min < limit:
                return False
        return True

    def matches(self, offer: "Offer", *, passengers: int = 1) -> bool:
        """`passengers` — скільки людей у ціні пропозиції (вона за весь склад, ADR 0013)."""
        legs = [offer.outbound, *([offer.inbound] if offer.inbound else [])]
        if self.max_stops is not None and any(leg.stops > self.max_stops for leg in legs):
            return False
        if self.airlines and offer.airlines and not set(offer.airlines) <= set(self.airlines):
            return False
        if set(offer.airlines) & set(self.excluded_airlines):
            return False
        out, back = offer.outbound, offer.inbound
        times = [
            (out.departure_at, self.departure_periods, self.departure_hours),
            (out.arrival_at, self.arrival_periods, self.arrival_hours),
        ]
        if back is not None:
            times += [
                (back.departure_at, self.return_departure_periods, self.return_departure_hours),
                (back.arrival_at, self.return_arrival_periods, self.return_arrival_hours),
            ]
        if not all(_time_ok(at, periods, hours) for at, periods, hours in times):
            return False
        if not all(self._layovers_ok(leg) for leg in legs):
            return False
        if self.max_price is not None and offer.price > self.max_price * passengers:
            return False
        if self.max_total_price is not None and offer.price > self.max_total_price:
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
    departure_until: date | None = None
    """Режим «період» (модуль 2a): виліт у будь-який день [departure_date, departure_until] —
    увесь місяць чи свій діапазон. Тривалість поїздки туди-назад — як return − departure."""
    min_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    max_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    """Пошук за тривалістю (модуль 2b): ночей на місці — від дати ПРИЛЬОТУ туди до дати вильоту
    назад. Лише для гнучкого пошуку туди-назад; `return_date` тоді — виліт + min_nights."""
    check_dates: list[DatePair] | None = Field(default=None, max_length=MAX_CHECK_DATES)
    """Конкретні пари дат для живої перевірки замість перебору вікна. Заповнює сервіс гнучкого
    пошуку з кешованих кандидатів (ADR 0016); бюджет запитів джерело ділить між ними."""
    passengers: Passengers = Passengers()
    cabin: Cabin = "economy"
    baggage: BaggageNeed = "none"
    """Багаж на кожного пасажира. Як і `profile`, лише для оцінки й видачі (не в запит джерела):
    SerpApi `bags` ціну не змінює (фікстура pax_carryon.json), даних про багаж не дає."""
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
        if self.departure_until is not None:
            if self.flex_days:
                raise ValueError("період і ±дні разом не задаються")
            span = (self.departure_until - self.departure_date).days
            if not 0 <= span <= MAX_PERIOD_DAYS:
                raise ValueError(f"період — від дати вильоту, до {MAX_PERIOD_DAYS} днів")
        if self.min_nights is not None or self.max_nights is not None:
            if self.min_nights is None or self.max_nights is None:
                raise ValueError("кількість ночей — від і до разом")
            if self.min_nights > self.max_nights:
                raise ValueError("мінімум ночей більший за максимум")
            if self.return_date is None or not self.is_flexible:
                raise ValueError("ночі задаються для гнучкого пошуку туди й назад")
        return self

    @property
    def nights_range(self) -> tuple[int, int] | None:
        if self.min_nights is None or self.max_nights is None:
            return None
        return self.min_nights, self.max_nights

    @property
    def is_flexible(self) -> bool:
        return bool(self.flex_days) or self.departure_until is not None

    @property
    def trip_days(self) -> int | None:
        return (self.return_date - self.departure_date).days if self.return_date else None

    @property
    def departure_window(self) -> tuple[date, date]:
        if self.departure_until is not None:
            return self.departure_date, self.departure_until
        delta = timedelta(days=self.flex_days)
        return self.departure_date - delta, self.departure_date + delta

    @property
    def return_window(self) -> tuple[date, date] | None:
        if self.return_date is None:
            return None
        start, end = self.departure_window
        if self.nights_range is not None:
            # Повернення — від найранішого вильоту + мінімум ночей до найпізнішого + максимум
            # (+1 день: нічний рейс прилітає наступного дня, ночі рахуємо від прильоту).
            low, high = self.nights_range
            return start + timedelta(days=low), end + timedelta(days=high + 1)
        if self.departure_until is not None:
            # Період: повернення зсувається разом з вильотом (та сама тривалість поїздки).
            return self.return_date, self.departure_until + timedelta(days=self.trip_days or 0)
        delta = timedelta(days=self.flex_days)
        return self.return_date - delta, self.return_date + delta

    def at_dates(self, departure: date, return_date: date | None) -> "FlightQuery":
        """Той самий запит на точні дати (для живої перевірки кандидата)."""
        return self.model_copy(
            update={
                "departure_date": departure,
                "return_date": return_date,
                "flex_days": 0,
                "departure_until": None,
                "min_nights": None,
                "max_nights": None,
                "check_dates": None,
            }
        )


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


class BagAllowance(_Frozen):
    status: Literal["included", "fee", "not_available"]
    fee: Money | None = Field(default=None, ge=0)
    """За статусу fee — ціна на одного пасажира за всю поїздку; None — плата є, сума невідома."""


class Baggage(_Frozen):
    """Умови багажу тарифу від джерела. None в полі — невідомо (а не «немає»), ADR 0004."""

    personal_item: BagAllowance | None = None
    carry_on: BagAllowance | None = None
    checked: BagAllowance | None = None
    checked_extra: BagAllowance | None = None
    """Друга зареєстрована валіза."""


def stay_nights(outbound: "Leg", inbound: "Leg") -> tuple[int, bool]:
    """Ночей на місці: від дати прильоту туди до дати вильоту назад (місцевий час аеропортів).

    Прибуття невідоме (кешовані рейси з пересадками) — від дати вильоту туди, з позначкою
    «орієнтовно» (True): справжніх ночей може бути на одну менше.
    """
    arrival = outbound.arrival_at
    start = arrival.date() if arrival is not None else outbound.departure_at.date()
    return (inbound.departure_at.date() - start).days, arrival is None


class Offer(_Frozen):
    id: str
    """Стабільний ідентифікатор у межах джерела (однаковий для тієї самої пропозиції)."""
    source: str
    price: Money = Field(gt=0)
    """Ціна за весь склад пасажирів і клас із запиту (ADR 0013); для 1 дорослого — за нього."""
    currency: Currency
    outbound: Leg
    inbound: Leg | None = None
    airlines: list[str]
    airline_logos: dict[str, str] = {}
    """Код авіакомпанії → URL логотипа від провайдера (лише перевірені хости)."""
    details_level: Literal["full", "summary"]
    """full — відомі сегменти й пересадки; summary — лише кількість пересадок і тривалість."""
    baggage_included: bool | None = None
    """Зареєстрований багаж у тарифі; None — провайдер не повідомляє умови багажу."""
    baggage: Baggage | None = None
    """Детальні умови (особиста річ, ручна, зареєстрований); None — джерело їх не дає."""
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
    price_status: Literal["live", "cached"] = "cached"
    """live — ціна з живого пошуку в момент запиту; cached — з кешу пошуків (див. found_at)."""
    cabin: Cabin | None = None
    """Клас обслуговування тарифу; None — невідомо."""
    fare_name: str | None = None
    """Назва тарифу продавця (Basic, Light…), якщо джерело її дає."""
    taxes: Money | None = Field(default=None, ge=0)
    """Податки й збори в ціні, якщо джерело їх виділяє; None — невідомо (ціна вже з ними)."""
    booking_ref: str | None = Field(default=None, max_length=4096)
    """Непрозорий токен джерела для запиту продавців і перевірки ціни (модуль 3); у SerpApi —
    `booking_token`. Лише для бекенду: веб передає його назад як є."""
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
