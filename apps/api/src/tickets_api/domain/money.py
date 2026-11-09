"""Гроші в різних валютах (модуль 18.2, ADR 0037). Без I/O: курс передають ззовні.

- **Вихідна ціна недоторкана.** `Offer.price` / `Stay.total_price` — сума й валюта джерела; її
  показуємо й пишемо в історію. Конвертована — окремо (`ConvertedPrice`), лише для порівняння.
- **Одна валюта порівняння** — валюта пошуку: ціни в інших валютах переводимо за курсом ЄЦБ,
  щоб скоринг і «найдешевший» порівнювали однакове.
- **Округлення** — до центів, половина вгору (ROUND_HALF_UP), лише в кінці.
- **Конвертоване завжди орієнтовне**: курс довідковий, продавець спише за своїм курсом у своїй
  валюті — гарантованою сумою списання його не називаємо.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from pydantic import BaseModel

CENT = Decimal("0.01")


def to_cents(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def convert(amount: Decimal, rate: Decimal) -> Decimal:
    """`rate` — одиниць цільової валюти за одиницю вихідної."""
    return to_cents(amount * rate)


class ConvertedPrice(BaseModel):
    amount: Decimal
    """У валюті порівняння (валюті пошуку), до центів."""
    currency: str
    original_amount: Decimal
    original_currency: str
    """Як дало джерело — саме в цій валюті ціну показує продавець."""
    rate: Decimal
    """Одиниць `currency` за 1 `original_currency` (довідковий курс ЄЦБ)."""
    approximate: Literal[True] = True
    """Завжди: це не сума списання."""


def converted(amount: Decimal, currency: str, target: str, rate: Decimal) -> ConvertedPrice:
    return ConvertedPrice(
        amount=convert(amount, rate),
        currency=target,
        original_amount=amount,
        original_currency=currency,
        rate=rate,
    )
