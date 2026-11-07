"""Підписка на ціну маршруту (алерт). Без I/O — лише моделі."""

from datetime import date, datetime
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import DEFAULT_CURRENCY, Currency, Iata, Money, _StrictInput

AlertCondition = Literal["below_price", "below_typical"]
"""below_price — ціна нижча за поріг; below_typical — нижча за медіану історії маршруту."""
AlertChannel = Literal["telegram", "email"]
AlertStatus = Literal["pending", "active", "stopped", "expired"]
"""pending — чекає підтвердження (Telegram /start чи лист); expired — дати минули."""
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
    origin: Iata
    destination: Iata
    departure_date: date
    return_date: date | None = None
    adults: int = Field(default=1, ge=1, le=9)
    condition: AlertCondition = "below_price"
    threshold: int | None = Field(default=None, ge=1, le=100_000)
    """Поріг за дорослого — для below_price."""
    currency: Currency = DEFAULT_CURRENCY
    channel: AlertChannel = "telegram"
    email: Email | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("місто вильоту й призначення мають відрізнятися")
        if self.return_date is not None and self.return_date < self.departure_date:
            raise ValueError("повернення не може бути раніше вильоту")
        if self.condition == "below_price" and self.threshold is None:
            raise ValueError("для «ціна нижча за» потрібен поріг")
        if self.channel == "email" and self.email is None:
            raise ValueError("для email-сповіщень потрібна адреса")
        if self.channel == "telegram" and self.email is not None:
            raise ValueError("email не потрібен для Telegram-сповіщень")
        return self


class AlertView(BaseModel):
    """Що бачить власник підписки на сторінці керування (без контактних даних)."""

    id: str
    origin: str
    destination: str
    departure_date: date
    return_date: date | None
    adults: int
    condition: AlertCondition
    threshold: int | None
    currency: str
    channel: AlertChannel
    status: AlertStatus
    created_at: datetime
    last_checked_at: datetime | None
    last_price: Money | None
    last_notified_price: Money | None
    last_notified_at: datetime | None
