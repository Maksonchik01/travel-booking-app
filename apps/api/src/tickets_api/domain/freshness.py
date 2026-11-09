"""Наскільки свіжа ціна (модуль 17.3, ADR 0034). Без I/O: лише правила від часу отримання.

- `live` — живе джерело, отримано щойно (не давніше за `live_fresh_min`): ціна на зараз;
- `cached` — кешоване джерело (ціну хтось знайшов раніше), вік відомий і невеликий;
- `approximate` — кешоване, а коли знайдено — невідомо: орієнтир, не ціна на зараз;
- `needs_recheck` — давно: живу ціну отримано давніше за `live_fresh_min`, кешовану знайдено
  давніше за `cached_stale_days`. Перед переходом варто перевірити (продавці, «Оновити ціни»).
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

PriceFreshness = Literal["live", "cached", "approximate", "needs_recheck"]


@dataclass(frozen=True)
class FreshnessRules:
    live_fresh_min: int = 30
    """Як TTL кешу джерел за замовчуванням: жива ціна з нашого кешу — ще «щойно»."""
    cached_stale_days: int = 3


def price_freshness(
    *,
    live: bool,
    collected_at: datetime,
    found_at: datetime | None,
    found_on: date | None,
    now: datetime,
    rules: FreshnessRules,
) -> PriceFreshness:
    if live:
        fresh = now - collected_at <= timedelta(minutes=rules.live_fresh_min)
        return "live" if fresh else "needs_recheck"
    seen = found_at or (datetime.combine(found_on, time(), UTC) if found_on else None)
    if seen is None:
        return "approximate"
    return "cached" if now - seen <= timedelta(days=rules.cached_stale_days) else "needs_recheck"
