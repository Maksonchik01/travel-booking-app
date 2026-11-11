"""Бюджет і облік зовнішніх API (V3, ADR 0055): спільний для всіх процесів лічильник у Redis.

Кожен HTTP-запит до джерела йде через `ProviderGate`, а шлюз — через `ApiMeter`:

- **Резерв перед запитом.** Lua-скрипт атомарно перевіряє годинний, добовий і місячний ліміти
  рахунку (`serpapi` — пошуки, `scrapedo` — кредити) і додає одиниці. Одночасні запити не
  проскочать ліміт: перевірка й додавання — одна операція Redis.
- **Неуспішний запит повертає резерв.** SerpApi і scrape.do списують лише успішні відповіді
  (тарифи станом на 2026-11): помилка, тайм-аут, 429 — без витрат.
- **Пріоритет.** Необов'язкові дорогі операції (`optional_spend()`: автоматична перевірка
  продавців, «знайти дешевше», житло в Explore, тарифи продавців житла) зупиняються на
  `optional_share` ліміту, щоб лишити запас для основного пошуку.
- **Облік** на добу (`api:stats:YYYY-MM-DD`): запити, успішні, помилки, заблоковані бюджетом,
  сумарний час — за рахунком і операцією. Вартість — одиниці × ціна одиниці з конфігу.
- **Redis недоступний** — запит пропускаємо (як і ліміти запитів): бюджет — захисна сітка, а
  без Redis не працює й кеш; подію пишемо в лог.

Без маршрутів, дат і людей — лише лічильники.
"""

import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Literal, cast

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.providers.base import ProviderRateLimitedError

log = structlog.get_logger(__name__)

Priority = Literal["essential", "optional"]
Period = Literal["hour", "day", "month"]
PERIODS: tuple[Period, ...] = ("hour", "day", "month")

_priority: ContextVar[Priority] = ContextVar("api_priority", default="essential")

STATS_PREFIX = "api:stats"
USAGE_PREFIX = "api:usage"
STATS_TTL_S = 40 * 24 * 3600
_TTL: dict[Period, int] = {"hour": 2 * 3600, "day": 2 * 86400, "month": 32 * 86400}

# KEYS — ключі годинного, добового й місячного лічильника; ARGV[1] — одиниці,
# ARGV[2..4] — ліміти (-1 — без ліміту), ARGV[5..7] — TTL. Повертає {дозволено, h, d, m}.
_RESERVE = """
local units = tonumber(ARGV[1])
local used = {}
for i = 1, 3 do
  used[i] = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[i + 1])
  if limit >= 0 and used[i] + units > limit then
    return {0, used[1] or 0, used[2] or 0, used[3] or 0}
  end
end
for i = 1, 3 do
  used[i] = redis.call('INCRBY', KEYS[i], units)
  if used[i] == units then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i + 4])) end
end
return {1, used[1], used[2], used[3]}
"""


@contextmanager
def optional_spend() -> Iterator[None]:
    """Платні запити всередині — необов'язкові: зупиняються раніше за основний пошук.

    ContextVar переходить у задачі asyncio, створені всередині (gather, create_task)."""
    token = _priority.set("optional")
    try:
        yield
    finally:
        _priority.reset(token)


def current_priority() -> Priority:
    return _priority.get()


@dataclass(frozen=True, slots=True)
class AccountBudget:
    """Ліміти одного платного рахунку в його одиницях (None — без ліміту)."""

    hourly: int | None = None
    daily: int | None = None
    monthly: int | None = None
    units_per_request: int = 1
    unit_cost_usd: Decimal = Decimal(0)
    """Оцінка вартості одиниці (USD): за найближчим платним тарифом, навіть на безкоштовному."""

    def limit(self, period: Period) -> int | None:
        return {"hour": self.hourly, "day": self.daily, "month": self.monthly}[period]


class ProviderBudgetError(ProviderRateLimitedError):
    """Ліміт бюджету SkyPack вичерпано — запит до джерела не робили (статус `rate_limited`)."""


@dataclass(frozen=True, slots=True)
class Ticket:
    account: str
    operation: str
    units: int
    keys: tuple[str, str, str] | None
    """Ключі лічильників, куди додали одиниці; None — нічого не резервували (Redis недоступний)."""
    started: float


class ApiMeter:
    def __init__(
        self,
        redis: Redis,
        budgets: dict[str, AccountBudget],
        *,
        optional_share: float = 0.8,
        warn_share: float = 0.8,
        clock: Callable[[], datetime] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._redis = redis
        self._budgets = budgets
        self._optional_share = optional_share
        self._warn_share = warn_share
        self._clock = clock or (lambda: datetime.now(UTC))
        self._monotonic = monotonic
        self._script = redis.register_script(_RESERVE)

    @property
    def budgets(self) -> dict[str, AccountBudget]:
        return self._budgets

    def usage_keys(self, account: str, now: datetime) -> tuple[str, str, str]:
        return (
            f"{USAGE_PREFIX}:{account}:h:{now:%Y-%m-%dT%H}",
            f"{USAGE_PREFIX}:{account}:d:{now:%Y-%m-%d}",
            f"{USAGE_PREFIX}:{account}:m:{now:%Y-%m}",
        )

    async def reserve(self, account: str, operation: str) -> Ticket:
        """Зарезервувати одиниці під запит або кинути `ProviderBudgetError`."""
        budget = self._budgets.get(account, AccountBudget())
        units = budget.units_per_request
        now = self._clock()
        keys = self.usage_keys(account, now)
        priority = current_priority()
        share = self._optional_share if priority == "optional" else 1.0
        limits = [budget.limit(p) for p in PERIODS]
        effective = [-1 if limit is None else int(limit * share) for limit in limits]
        try:
            allowed, *used = await self._script(
                keys=list(keys), args=[units, *effective, *(_TTL[p] for p in PERIODS)]
            )
        except (RedisError, OSError) as exc:
            log.warning("api_budget.redis_failed", account=account, error=type(exc).__name__)
            return Ticket(account, operation, units, None, self._monotonic())
        if not allowed:
            await self._count(account, operation, "blocked")
            # Одне попередження на годину й рахунок, решта — debug: інакше лог засипає.
            first = await self._first(f"{keys[0]}:blocked:{priority}", _TTL["hour"])
            (log.warning if first else log.debug)(
                "api_budget.blocked",
                account=account,
                operation=operation,
                priority=priority,
                used=dict(zip(PERIODS, map(int, used), strict=True)),
            )
            raise ProviderBudgetError(account, f"SkyPack budget reached ({priority})")
        await self._warn(account, budget, keys, [int(u) for u in used])
        return Ticket(account, operation, units, keys, self._monotonic())

    async def settle(self, ticket: Ticket, *, ok: bool) -> None:
        """Після запиту: успішний — витрата лишається, інакше резерв повертаємо."""
        elapsed_ms = int((self._monotonic() - ticket.started) * 1000)
        day = f"{STATS_PREFIX}:{self._clock():%Y-%m-%d}"
        field = f"{ticket.account}:{ticket.operation}"
        try:
            pipe = self._redis.pipeline(transaction=False)
            if not ok and ticket.keys is not None:
                for key in ticket.keys:
                    pipe.decrby(key, ticket.units)
            pipe.hincrby(day, f"{field}:req", 1)
            pipe.hincrby(day, f"{field}:{'ok' if ok else 'err'}", 1)
            pipe.hincrby(day, f"{field}:ms", elapsed_ms)
            if ok:
                pipe.hincrby(day, f"{field}:units", ticket.units)
            pipe.expire(day, STATS_TTL_S)
            await pipe.execute()
        except (RedisError, OSError) as exc:
            log.warning("api_budget.settle_failed", error=type(exc).__name__)

    async def _count(self, account: str, operation: str, what: str) -> None:
        day = f"{STATS_PREFIX}:{self._clock():%Y-%m-%d}"
        try:
            pipe = self._redis.pipeline(transaction=False)
            pipe.hincrby(day, f"{account}:{operation}:{what}", 1)
            pipe.expire(day, STATS_TTL_S)
            await pipe.execute()
        except (RedisError, OSError):
            pass

    async def _first(self, key: str, ttl_s: int) -> bool:
        try:
            return bool(await self._redis.set(key, 1, nx=True, ex=ttl_s))
        except (RedisError, OSError):
            return True

    async def _warn(
        self, account: str, budget: AccountBudget, keys: tuple[str, str, str], used: list[int]
    ) -> None:
        """Перетнули `warn_share` добового чи місячного ліміту — одне попередження на період."""
        for period, key, value in zip(PERIODS, keys, used, strict=True):
            limit = budget.limit(period)
            if period == "hour" or not limit or value < limit * self._warn_share:
                continue
            try:
                first = await self._redis.set(f"{key}:warned", 1, nx=True, ex=_TTL[period])
            except (RedisError, OSError):
                return
            if first:
                log.warning(
                    "api_budget.warning", account=account, period=period, used=value, limit=limit
                )

    async def note_search(self, kind: str, *, ok: bool) -> None:
        """Пошук для собівартості: `ok` — є результат (знайдено хоч щось)."""
        await self._count("search", kind, "ok" if ok else "empty")

    async def usage(self, account: str) -> dict[Period, int]:
        keys = self.usage_keys(account, self._clock())
        values = await self._redis.mget(list(keys))
        return {p: int(v or 0) for p, v in zip(PERIODS, values, strict=True)}

    async def stats(self, days: int = 7) -> dict[str, int]:
        """Сума денних лічильників за останні `days` днів (включно з сьогодні)."""
        now = self._clock()
        totals: dict[str, int] = {}
        for i in range(days):
            day = f"{STATS_PREFIX}:{(now - timedelta(days=i)):%Y-%m-%d}"
            # redis-py типізує hgetall як «або синхронний, або асинхронний» результат.
            raw = await cast(Awaitable[dict[bytes, bytes]], self._redis.hgetall(day))
            for field, value in raw.items():
                name = field.decode() if isinstance(field, bytes) else str(field)
                totals[name] = totals.get(name, 0) + int(value)
        return totals
