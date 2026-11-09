"""Підписка на ціну маршруту (алерт). Без I/O — лише моделі."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import (
    DEFAULT_CURRENCY,
    MAX_NIGHTS,
    MAX_PERIOD_DAYS,
    BaggageNeed,
    Currency,
    Iata,
    Money,
    _StrictInput,
)

AlertKind = Literal["flight", "flex", "stay", "trip"]
"""flight — маршрут на дати; flex — період вильоту й тривалість (модуль 11a); stay — житло;
trip — переліт + житло. stay/trip вмикаються лише з реальним джерелом житла."""
AlertCondition = Literal["below_price", "below_typical", "drop_amount", "drop_percent"]
"""below_price — не дорожче за поріг; below_typical — нижче медіани історії маршруту;
drop_amount / drop_percent — дешевше за ціну першої перевірки на суму / відсоток."""
SIGNIFICANT_PERCENT = 3
"""Повторне сповіщення — лише якщо ціна впала ще щонайменше на 3% від попереднього
(для drop_* — ще на ту саму суму / відсоток): без нової істотної зміни не пишемо."""
StayKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_-]{1,20}:[\w.-]{1,80}$")]
AlertChannel = Literal["telegram", "email"]
AlertStatus = Literal["pending", "active", "paused", "stopped", "expired"]
"""pending — чекає підтвердження (Telegram /start чи лист); paused — призупинена власником
(не перевіряємо, можна відновити); stopped — вимкнена; expired — дати минули."""
AlertEventKind = Literal[
    "created",
    "confirmed",
    "checked",
    "notified",
    "held",
    "paused",
    "resumed",
    "edited",
    "snoozed",
    "threshold",
    "stopped",
    "expired",
]
"""snoozed — «тиша» з бота (detail — до якої дати); threshold — новий поріг з бота."""
EDITABLE_FIELDS = (
    "departure_date",
    "return_date",
    "departure_until",
    "min_nights",
    "max_nights",
    "weekends",
    "adults",
    "baggage",
    "condition",
    "threshold",
    "percent",
)
"""Що можна змінити в підписці (11.3). Маршрут, тип, валюта й канал — лише новою підпискою."""
SEARCH_FIELDS = frozenset(EDITABLE_FIELDS[:8])
"""Зміна цих полів — інший пошук: ціни й база для зниження починаються заново."""
# Перевірка форми адреси без окремої залежності: що адреса справжня, підтверджує лист
# (подвійна згода) — без кліку на посилання підписка не активується.
Email = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"),
    AfterValidator(str.lower),
]
TYPICAL_DISCOUNT_PERCENT = 10
"""«Нижче типової» = щонайменше на 10% нижче медіани історії цін маршруту."""


class AlertCreate(_StrictInput):
    kind: AlertKind = "flight"
    origin: Iata | None = None
    """Звідки (переліт, поїздка); для житла — немає."""
    destination: Iata
    """Куди; для житла — місто."""
    departure_date: date
    """Виліт (для житла — заїзд); для flex — початок періоду вильоту."""
    return_date: date | None = None
    """Повернення (для житла — виїзд). Для flex не задається: його дає тривалість."""
    departure_until: date | None = None
    """flex: кінець періоду вильоту."""
    min_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    max_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    weekends: bool = False
    """flex: лише вихідні — виліт чт–сб, повернення сб–пн."""
    adults: int = Field(default=1, ge=1, le=9)
    baggage: BaggageNeed = "none"
    """Потрібний багаж: у посилання на пошук; ціну з багажем порівнюємо, лише якщо вона відома."""
    stay_key: StayKey | None = None
    """stay: конкретний об'єкт (`source:id`); без нього — будь-яка пропозиція в місті."""
    condition: AlertCondition = "below_price"
    threshold: int | None = Field(default=None, ge=1, le=100_000)
    """Поріг за всіх (below_price) або сума зниження (drop_amount)."""
    percent: int | None = Field(default=None, ge=1, le=90)
    """Відсоток зниження (drop_percent)."""
    currency: Currency = DEFAULT_CURRENCY
    channel: AlertChannel = "telegram"
    email: Email | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.kind != "stay" and self.origin is None:
            raise ValueError("потрібне місто вильоту")
        if self.kind == "stay" and self.return_date is None:
            raise ValueError("для житла потрібна дата виїзду")
        if self.origin == self.destination:
            raise ValueError("місто вильоту й призначення мають відрізнятися")
        if self.return_date is not None and self.return_date < self.departure_date:
            raise ValueError("повернення не може бути раніше вильоту")
        if self.kind == "flex":
            if self.departure_until is None or self.min_nights is None:
                raise ValueError("гнучкі дати: потрібні кінець періоду й тривалість")
            span = (self.departure_until - self.departure_date).days
            if not 0 <= span <= MAX_PERIOD_DAYS:
                raise ValueError(f"період — від дати вильоту, до {MAX_PERIOD_DAYS} днів")
            if self.max_nights is not None and self.max_nights < self.min_nights:
                raise ValueError("тривалість «до» менша за «від»")
            if self.return_date is not None:
                raise ValueError("для гнучких дат повернення задає тривалість")
        elif self.departure_until or self.min_nights or self.max_nights or self.weekends:
            raise ValueError("період і тривалість — лише для гнучких дат")
        if self.stay_key is not None and self.kind != "stay":
            raise ValueError("об'єкт житла — лише для сповіщення про житло")
        if self.condition in ("below_price", "drop_amount") and self.threshold is None:
            raise ValueError("для цієї умови потрібна сума")
        if self.condition == "drop_percent" and self.percent is None:
            raise ValueError("для зниження на відсоток потрібен відсоток")
        if self.condition == "below_typical" and self.kind != "flight":
            raise ValueError("«нижче типової» — лише для маршруту на дати")
        if self.channel == "email" and self.email is None:
            raise ValueError("для email-сповіщень потрібна адреса")
        if self.channel == "telegram" and self.email is not None:
            raise ValueError("email не потрібен для Telegram-сповіщень")
        return self


class AlertEdit(_StrictInput):
    """Редагування підписки: усі змінювані поля разом (форма надсилає їх усі)."""

    departure_date: date
    return_date: date | None = None
    departure_until: date | None = None
    min_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    max_nights: int | None = Field(default=None, ge=1, le=MAX_NIGHTS)
    weekends: bool = False
    adults: int = Field(default=1, ge=1, le=9)
    baggage: BaggageNeed = "none"
    condition: AlertCondition = "below_price"
    threshold: int | None = Field(default=None, ge=1, le=100_000)
    percent: int | None = Field(default=None, ge=1, le=90)


class AlertEventOut(BaseModel):
    """Запис історії підписки: спрацювання, затримки, зміни статусу (без текстів листів)."""

    kind: AlertEventKind
    price: Money | None
    detail: str | None
    created_at: datetime


class AlertView(BaseModel):
    """Що бачить власник підписки на сторінці керування (без контактних даних)."""

    id: str
    kind: AlertKind = "flight"
    origin: str | None
    destination: str
    departure_date: date
    return_date: date | None
    departure_until: date | None = None
    min_nights: int | None = None
    max_nights: int | None = None
    weekends: bool = False
    adults: int
    baggage: BaggageNeed = "none"
    stay_key: str | None = None
    condition: AlertCondition
    threshold: int | None
    percent: int | None = None
    baseline_price: Money | None = None
    """Ціна першої перевірки — від неї рахуємо зниження (drop_*)."""
    currency: str
    channel: AlertChannel
    status: AlertStatus
    created_at: datetime
    last_checked_at: datetime | None
    last_price: Money | None
    last_notified_price: Money | None
    last_notified_at: datetime | None


def triggered(
    condition: AlertCondition,
    *,
    best: Decimal,
    threshold: int | None,
    percent: int | None,
    baseline: Decimal | None,
    previous: Decimal | None,
    typical_limit: Decimal | None = None,
) -> bool:
    """Чи виконана умова й чи це нова істотна зміна (`previous` — ціна минулого сповіщення).

    below_typical: `typical_limit` — межа «нижче типової» (None — історії замало).
    """
    if condition == "below_price":
        met = threshold is not None and best <= threshold
        step = _percent_step(previous, SIGNIFICANT_PERCENT)
    elif condition == "below_typical":
        met = typical_limit is not None and best <= typical_limit
        step = _percent_step(previous, SIGNIFICANT_PERCENT)
    elif condition == "drop_amount":
        met = threshold is not None and baseline is not None and best <= baseline - threshold
        step = previous - threshold if previous is not None and threshold is not None else None
    else:
        met = percent is not None and baseline is not None and best <= _less(baseline, percent)
        step = _percent_step(previous, percent or SIGNIFICANT_PERCENT)
    return met and (step is None or best <= step)


def _less(value: Decimal, percent: int) -> Decimal:
    return value * (Decimal(100 - percent) / 100)


def _percent_step(previous: Decimal | None, percent: int) -> Decimal | None:
    return _less(previous, percent) if previous is not None else None
