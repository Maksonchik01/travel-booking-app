"""«В обране» (модуль 7): структурований знімок об'єкта на момент збереження. Без I/O.

Ціна в знімку — історична: UI підписує її датою збереження й не видає за актуальну.
"""

from datetime import date, datetime
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import Currency, Iata, Money, _StrictInput
from tickets_api.domain.stays import MAX_NIGHTS, StayKind

FavoriteKind = Literal["stay"]
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


class FavoriteBody(_StrictInput):
    kind: FavoriteKind = "stay"
    stay: FavoriteStay


class FavoritesImport(_StrictInput):
    """Обране гостя з браузера — до акаунта після входу (повтори пропускаються)."""

    items: list[FavoriteBody] = Field(max_length=MAX_FAVORITES)


class FavoriteOut(BaseModel):
    id: str
    kind: FavoriteKind
    item_key: str
    stay: FavoriteStay
    created_at: datetime
