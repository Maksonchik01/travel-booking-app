"""Кінцева вартість з потрібним багажем (модуль 1b ТЗ, ADR 0014). Лише код, ніколи LLM.

Платимо за багаж кожного, хто має на нього норму: дорослі, діти й немовлята з місцем
(немовля на руках окремої норми не має). Невідома умова — `unknown`, а не «безкоштовно».
"""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import (
    BAGS_FOR_NEED,
    BaggageNeed,
    BagKind,
    Money,
    Offer,
    Passengers,
)

BaggageStatus = Literal["included", "extra", "unknown", "not_available"]


class BaggageCost(BaseModel):
    status: BaggageStatus
    """included — усе потрібне в тарифі; extra — доплата відома; unknown — щось невідомо;
    not_available — тариф цього багажу не дозволяє."""
    extra: Money | None
    """Доплата за багаж усіх пасажирів; None — невідома."""
    total: Money | None
    """Ціна квитків + доплата; None — кінцева вартість невідома."""
    unknown: list[BagKind]
    """Які місця багажу мають невідомі умови чи суму."""


def baggage_cost(offer: Offer, need: BaggageNeed, passengers: Passengers) -> BaggageCost:
    payers = Decimal(passengers.seated)
    extra = Decimal(0)
    unknown: list[BagKind] = []
    for bag in BAGS_FOR_NEED[need]:
        allowance = getattr(offer.baggage, bag) if offer.baggage else None
        if allowance is None:
            unknown.append(bag)
        elif allowance.status == "not_available":
            return BaggageCost(status="not_available", extra=None, total=None, unknown=[])
        elif allowance.status == "fee":
            if allowance.fee is None:
                unknown.append(bag)
            else:
                extra += allowance.fee * payers
    if unknown:
        return BaggageCost(status="unknown", extra=None, total=None, unknown=unknown)
    return BaggageCost(
        status="extra" if extra else "included",
        extra=extra,
        total=offer.price + extra,
        unknown=[],
    )
