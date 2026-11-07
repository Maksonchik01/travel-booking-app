"""Поїздка «переліт туди-назад + житло на ці дати». Без I/O — лише моделі запиту."""

from datetime import date
from typing import Literal, Self

from pydantic import Field, model_validator

from tickets_api.domain.flights import DEFAULT_CURRENCY, Currency, Iata, _StrictInput
from tickets_api.domain.stays import MAX_NIGHTS, StayProfile
from tickets_api.scoring.config import Profile

TripProfile = Literal["budget", "balanced", "comfort"]
"""Що важливіше в поїздці. Мапиться на профілі скорингу перельотів і житла."""
MAX_TRIP_FLEX_DAYS = 3

FLIGHT_PROFILE: dict[TripProfile, Profile] = {
    "budget": "budget",
    "balanced": "balanced",
    "comfort": "time_is_money",
}
STAY_PROFILE: dict[TripProfile, StayProfile] = {
    "budget": "budget",
    "balanced": "balanced",
    "comfort": "center",
}


class TripQuery(_StrictInput):
    origin: Iata
    destination: Iata
    departure_date: date
    return_date: date
    """Повернення обов'язкове: без нього не визначити ночі житла."""
    flex_days: int = Field(default=0, ge=0, le=MAX_TRIP_FLEX_DAYS)
    adults: int = Field(default=2, ge=1, le=9)
    children: int = Field(default=0, ge=0, le=8)
    """І для житла, і для перельоту: ціну дітей рахує джерело (ADR 0013)."""
    direct_only: bool = False
    profile: TripProfile = "balanced"
    budget_total: int | None = Field(default=None, ge=1, le=1_000_000)
    """Бюджет на всю поїздку (переліт для дорослих + житло), у валюті пошуку."""
    currency: Currency = DEFAULT_CURRENCY

    @model_validator(mode="after")
    def _route_and_dates(self) -> Self:
        if self.origin == self.destination:
            raise ValueError("місто вильоту й призначення мають відрізнятися")
        if self.return_date <= self.departure_date:
            raise ValueError("повернення має бути пізніше за виліт")
        if (self.return_date - self.departure_date).days > MAX_NIGHTS:
            raise ValueError(f"поїздка не довша за {MAX_NIGHTS} ночей")
        return self
