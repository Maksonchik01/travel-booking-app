"""Зручність часу перельотів у поїздці (модуль 8a): факти про час і їхня «ціна». Лише код.

Час прильоту туди й вильоту назад — місцевий час аеропорту з рядка провайдера (без
перерахунку поясів). Попередження — факти; штраф — лише в оцінку «Оптимального» сценарію.
"""

import tomllib
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tickets_api.domain.flights import Offer

DEFAULT_TRIP_CONFIG_PATH = Path(__file__).with_name("trip.toml")

TimingWarning = Literal["night_arrival", "late_arrival", "early_return", "late_return"]


class _Strict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class TripTiming(_Strict):
    night_arrival_before: int = Field(ge=0, le=12)
    night_arrival: Decimal = Field(ge=0)
    late_arrival_from: int = Field(ge=12, le=24)
    late_arrival: Decimal = Field(ge=0)
    early_return_before: int = Field(ge=0, le=12)
    early_return: Decimal = Field(ge=0)
    late_return_from: int = Field(ge=12, le=24)
    late_return: Decimal = Field(ge=0)


class TripScoringConfig(_Strict):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    timing: TripTiming


def load_trip_scoring_config(path: Path) -> TripScoringConfig:
    with path.open("rb") as f:
        return TripScoringConfig.model_validate(tomllib.load(f, parse_float=Decimal))


@lru_cache
def default_trip_scoring_config() -> TripScoringConfig:
    return load_trip_scoring_config(DEFAULT_TRIP_CONFIG_PATH)


def timing(offer: Offer, config: TripScoringConfig) -> tuple[Decimal, list[TimingWarning]]:
    """Штраф за незручний час на одного пасажира й попередження. Невідомий час — без штрафу."""
    t = config.timing
    penalty = Decimal(0)
    warnings: list[TimingWarning] = []
    arrival = offer.outbound.arrival_at
    if arrival is not None:
        if arrival.hour < t.night_arrival_before:
            penalty += t.night_arrival
            warnings.append("night_arrival")
        elif arrival.hour >= t.late_arrival_from:
            penalty += t.late_arrival
            warnings.append("late_arrival")
    if offer.inbound is not None:
        back = offer.inbound.departure_at
        if back.hour < t.early_return_before:
            penalty += t.early_return
            warnings.append("early_return")
        elif back.hour >= t.late_return_from:
            penalty += t.late_return
            warnings.append("late_return")
    return penalty, warnings
