"""Вартість виклику моделі за токенами (ціни й години пік — у pricing.toml)."""

import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from tickets_api.llm.types import Usage

DEFAULT_PATH = Path(__file__).with_name("pricing.toml")
_PER_TOKEN = Decimal(1_000_000)


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input_cache_hit: Decimal
    input_cache_miss: Decimal
    output: Decimal


@dataclass(frozen=True, slots=True)
class Pricing:
    currency: str
    off_peak_factor: Decimal
    peak_hours_utc: tuple[tuple[int, int], ...]
    models: dict[str, ModelPrice]

    def is_peak(self, at: datetime) -> bool:
        """Пн–пт у вказані години UTC (`at` — aware datetime)."""
        utc = at.astimezone(UTC)
        if utc.weekday() >= 5:
            return False
        return any(start <= utc.hour < end for start, end in self.peak_hours_utc)

    def cost(self, model: str, usage: Usage, at: datetime) -> Decimal | None:
        """None — моделі немає в прайсі (вартість невідома, а не нульова)."""
        price = self.models.get(model)
        if price is None:
            return None
        raw = (
            usage.input_cache_hit * price.input_cache_hit
            + usage.input_cache_miss * price.input_cache_miss
            + usage.output * price.output
        ) / _PER_TOKEN
        factor = Decimal(1) if self.is_peak(at) else self.off_peak_factor
        return (raw * factor).quantize(Decimal("0.000001"))


def load_pricing(path: Path = DEFAULT_PATH) -> Pricing:
    data = tomllib.loads(path.read_text())
    return Pricing(
        currency=str(data["currency"]),
        off_peak_factor=Decimal(str(data["off_peak_factor"])),
        peak_hours_utc=tuple((int(a), int(b)) for a, b in data["peak_hours_utc"]),
        models={
            name: ModelPrice(**{k: Decimal(str(v)) for k, v in prices.items()})
            for name, prices in data["models"].items()
        },
    )


@lru_cache
def default_pricing() -> Pricing:
    return load_pricing()
