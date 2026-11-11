"""Пропозиції продавців одного рейсу (модуль 3, ADR 0017)."""

from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

from tickets_api.domain.flights import Currency, FlightQuery, Money, _Frozen, _StrictInput

GOOGLE_BOOKING_URL = "https://www.google.com/travel/clk/f"
"""Перехід до продавця через Google (SerpApi `booking_request`): POST з `post_data`."""


class BookingLink(_Frozen):
    url: str
    method: Literal["GET", "POST"] = "GET"
    post_data: str | None = Field(default=None, max_length=8192)
    """Для POST — тіло форми (application/x-www-form-urlencoded) як дало джерело."""


class SellerOffer(_Frozen):
    seller: str
    is_airline: bool
    """Продає сама авіакомпанія (а не агенція)."""
    price: Money = Field(gt=0)
    """Ціна в продавця за весь склад пасажирів запиту."""
    currency: Currency
    included: list[str] = Field(default_factory=list)
    """Що входить у тариф — текст джерела як є (напр. «1 free carry-on»); порожньо — невідомо."""
    fare_name: str | None = None
    link: BookingLink | None = None
    checked_at: AwareDatetime
    """Коли джерело дало цю ціну (з кешу — час тієї перевірки)."""


class SellersRequest(_StrictInput):
    query: FlightQuery
    """Той самий пошук, з якого пропозиція (джерелу потрібні маршрут і дати)."""
    source: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    booking_ref: str = Field(min_length=1, max_length=4096)
    auto: bool = False
    """Запущено саме (перша картка), а не кнопкою — необов'язкова витрата квоти (ADR 0055)."""


class SellersResult(BaseModel):
    status: Literal["ok", "unsupported", "error", "rate_limited"]
    """unsupported — джерело не вміє перевіряти продавців: остаточну ціну підтверджує продавець."""
    sellers: list[SellerOffer] = []
    checked_at: datetime | None = None
    """Коли джерело перевірило цих продавців (з кешу — час тієї перевірки); None — не перевіряли."""
