import tomllib
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal, Self, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

Profile = Literal["budget", "balanced", "time_is_money"]
DEFAULT_CONFIG_PATH = Path(__file__).with_name("config.toml")


class _Strict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ProfileWeights(_Strict):
    lambda_time_per_hour: Decimal = Field(ge=0)
    lambda_stop: Decimal = Field(ge=0)


class Penalties(_Strict):
    short_layover: Decimal = Field(ge=0)
    overnight_layover: Decimal = Field(ge=0)
    self_transfer: Decimal = Field(ge=0)
    night_departure: Decimal = Field(ge=0)
    night_arrival: Decimal = Field(ge=0)
    airport_change: Decimal = Field(ge=0)


class PreferencePenalties(_Strict):
    airline: Decimal = Field(ge=0)
    departure_time: Decimal = Field(ge=0)


class Thresholds(_Strict):
    short_layover_min: int = Field(gt=0)
    long_layover_min: int = Field(gt=0)
    night_start_hour: int = Field(ge=0, le=23)
    night_end_hour: int = Field(ge=1, le=24)

    @model_validator(mode="after")
    def _night_window(self) -> Self:
        if self.night_start_hour >= self.night_end_hour:
            raise ValueError("night_start_hour має бути меншим за night_end_hour")
        return self


class ScoringConfig(_Strict):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    profiles: dict[Profile, ProfileWeights]
    penalties: Penalties
    preferences: PreferencePenalties
    thresholds: Thresholds

    @model_validator(mode="after")
    def _all_profiles(self) -> Self:
        missing = set(get_args(Profile)) - set(self.profiles)
        if missing:
            raise ValueError(f"у конфігу бракує профілів: {sorted(missing)}")
        return self

    def in_currency(self, currency: str, rate: Decimal) -> "ScoringConfig":
        """Ті самі ваги в іншій валюті: гроші × курс (одиниць `currency` за одиницю нашої).

        Лише гроші (вартість години, пересадки, штрафи); пороги в хвилинах і годинах — як є.
        """
        if currency == self.currency:
            return self
        return self.model_copy(
            update={
                "currency": currency,
                "profiles": {
                    name: ProfileWeights(
                        lambda_time_per_hour=w.lambda_time_per_hour * rate,
                        lambda_stop=w.lambda_stop * rate,
                    )
                    for name, w in self.profiles.items()
                },
                "penalties": Penalties(
                    **{k: v * rate for k, v in self.penalties.model_dump().items()}
                ),
                "preferences": PreferencePenalties(
                    **{k: v * rate for k, v in self.preferences.model_dump().items()}
                ),
            }
        )


def load_scoring_config(path: Path) -> ScoringConfig:
    # parse_float=Decimal: суми в грошах не проходять через float.
    with path.open("rb") as f:
        return ScoringConfig.model_validate(tomllib.load(f, parse_float=Decimal))


@lru_cache
def default_scoring_config() -> ScoringConfig:
    return load_scoring_config(DEFAULT_CONFIG_PATH)
