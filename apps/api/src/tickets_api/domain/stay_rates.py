"""Пропозиції продавців для одного об'єкта житла (модуль 7, ADR 0020).

Порівнюємо лише однакові умови: дати й гості — з того самого запиту, а номер, тип ліжка,
харчування й умови скасування — ключ групи. Різні номери одного готелю не зливаються.
Невідоме — None: податки чи збори, яких джерело не назвало, не вважаємо нульовими.
"""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

from tickets_api.domain.flights import Currency, Money, _Frozen, _StrictInput
from tickets_api.domain.stays import Cancellation, Prepayment, StayQuery

MealPlan = Literal["room_only", "breakfast", "half_board", "full_board", "all_inclusive"]
BedType = Literal["double", "twin", "single", "bunk", "sofa_bed"]
"""double — одне велике ліжко; twin — два окремих; bunk — ліжко в загальному номері."""
RatesStatus = Literal["ok", "unsupported", "rate_limited", "error"]


class StayRate(_Frozen):
    """Тариф одного продавця на один номер за весь період і всіх гостей запиту."""

    seller: str
    is_property: bool = False
    """Продає сам об'єкт (його сайт), а не посередник."""
    room_name: str
    room_code: str | None = None
    """Ідентифікатор номера в джерелі — надійніший за назву для зіставлення."""
    bed_type: BedType | None = None
    meal: MealPlan | None = None
    cancellation: Cancellation | None = None
    free_cancellation_until: date | None = None
    prepayment: Prepayment | None = None
    price_total: Money = Field(gt=0)
    """Що просить продавець за всі ночі."""
    taxes_included: bool | None = None
    """None — продавець не каже, чи податки в ціні."""
    taxes: Money | None = Field(default=None, ge=0)
    """Сума податків, якщо відома (у ціні чи понад неї — дивись `taxes_included`)."""
    fees_at_property: Money | None = Field(default=None, ge=0)
    """Обов'язкові збори на місці (туристичний податок тощо): 0 — немає, None — невідомо."""
    currency: Currency
    deep_link: str | None = None
    sponsored: bool = False
    """Рекламне розміщення в джерелі (Google Hotels позначає його так само)."""
    checked_at: AwareDatetime

    @property
    def final_total(self) -> Decimal | None:
        """Кінцева сума за умовами, або None, якщо хоч одна складова невідома."""
        if self.taxes_included is None or self.fees_at_property is None:
            return None
        if not self.taxes_included:
            if self.taxes is None:
                return None
            return self.price_total + self.taxes + self.fees_at_property
        return self.price_total + self.fees_at_property


class StayRatesRequest(_StrictInput):
    query: StayQuery
    """Той самий запит, що дав об'єкт: дати й гості для всіх продавців однакові."""
    source: str
    stay_id: str


class RateOffer(BaseModel):
    """Рядок порівняння: тариф і його кінцева сума."""

    rate: StayRate
    final_total: Money | None
    """None — податки чи збори невідомі: суму підтверджує продавець."""
    cheapest: bool = False
    """Найдешевший у групі серед рядків з відомою кінцевою сумою (і лише якщо їх ≥ 2)."""


class RoomOffers(BaseModel):
    """Група однакових умов: той самий номер, ліжко, харчування й скасування."""

    key: str
    room_name: str
    bed_type: BedType | None
    meal: MealPlan | None
    cancellation: Cancellation | None
    offers: list[RateOffer]
    """Від найдешевшої відомої кінцевої суми; невідомі — в кінці."""


class StayRatesResult(BaseModel):
    status: RatesStatus
    rooms: list[RoomOffers] = []
    sellers: int = 0
    """Скільки різних продавців у відповіді."""
    checked_at: AwareDatetime | None = None
    nights: int | None = None
