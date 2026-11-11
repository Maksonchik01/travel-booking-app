"""Технічні сповіщення власнику (V3, етап 10, ADR 0062). Запускає воркер раз на 15 хв.

Перевірки — з того, що вже рахується (`api:stats`, бюджети, ліміт витрат ШІ), без нових запитів
до платних джерел:

- **API недоступний** — `GET <OPS_API_URL>/health/ready` двічі поспіль не 200;
- **бюджет платного API** — використання ≥ `API_BUDGET_WARN_SHARE` добового чи місячного ліміту;
- **збої джерела** — за добу ≥ 10 запитів і ≥ 50 % помилок;
- **сповільнення** — середній час запиту до джерела сьогодні > 2× середнього за 6 попередніх
  днів і > 5 с;
- **витрати ШІ** — ≥ 80 % добового чи місячного ліміту;
- **сплеск лімітів запитів** — за добу ≥ `OPS_RATE_LIMIT_SPIKE` відмов 429 (схоже на бота).

Кожна проблема — не частіше, ніж раз на 6 год (`ops:alerted:<ключ>` у Redis). Канали — Telegram
(`OPS_TELEGRAM_CHAT_ID`) і/або email (`OPS_ALERT_EMAIL`); без них — лише лог. Критичні винятки
коду — правила сповіщень Sentry (налаштовуються в Sentry). Без PII: лише лічильники й назви.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.core.config import Settings
from tickets_api.llm.metered import LLMSpendGuard
from tickets_api.notifications.mail import Mailer
from tickets_api.notifications.telegram import TelegramClient
from tickets_api.providers.budget import STATS_PREFIX, ApiMeter

log = structlog.get_logger(__name__)

REPEAT_AFTER_S = 6 * 3600
MIN_REQUESTS = 10
ERROR_SHARE = 0.5
SLOW_FACTOR = 2.0
SLOW_MIN_MS = 5000
LLM_WARN_SHARE = Decimal("0.8")


@dataclass(frozen=True, slots=True)
class Problem:
    key: str
    """Стабільний ключ для дедуплікації (без чисел, що змінюються)."""
    text: str


class OpsWatch:
    def __init__(
        self,
        settings: Settings,
        *,
        redis: Redis,
        http: httpx.AsyncClient,
        meter: ApiMeter,
        spend_guard: LLMSpendGuard,
        telegram: TelegramClient,
        mailer: Mailer,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._redis = redis
        self._http = http
        self._meter = meter
        self._guard = spend_guard
        self._telegram = telegram
        self._mailer = mailer
        self._clock = clock or (lambda: datetime.now(UTC))

    async def run(self) -> list[Problem]:
        """Усі перевірки; повертає знайдені проблеми (надіслані — лише нові за 6 год)."""
        problems: list[Problem] = []
        for check in (self._api, self._budgets, self._providers, self._llm):
            try:
                problems += await check()
            except Exception as exc:  # одна перевірка не зупиняє решту
                log.warning(
                    "ops_watch.check_failed", check=check.__name__, error=type(exc).__name__
                )
        for problem in problems:
            if await self._first(problem.key):
                await self._notify(problem)
        return problems

    async def _api(self) -> list[Problem]:
        url = self._settings.ops_api_url
        if not url:
            return []
        try:
            response = await self._http.get(f"{url.rstrip('/')}/health/ready", timeout=20)
            healthy = response.status_code == 200
        except httpx.HTTPError:
            healthy = False
        key = "ops:api_failures"
        if healthy:
            await self._redis.delete(key)
            return []
        failures = int(await self._redis.incr(key))
        await self._redis.expire(key, 3600)
        if failures < 2:  # один збій — може бути пробудження Render free
            return []
        return [
            Problem("api_down", f"API недоступний: {failures} перевірки поспіль без відповіді 200.")
        ]

    async def _budgets(self) -> list[Problem]:
        problems = []
        share = self._settings.api_budget_warn_share
        for account in self._meter.budgets:
            budget = await self._meter.effective(account)
            used = await self._meter.usage(account)
            for period in ("day", "month"):
                limit = budget.limit(period)
                if limit and used[period] >= limit * share:
                    problems.append(
                        Problem(
                            f"budget:{account}:{period}",
                            f"Бюджет {account}: {used[period]} з {limit} за "
                            f"{'добу' if period == 'day' else 'місяць'} "
                            f"({used[period] / limit:.0%}). Необов'язкові операції вже зупинено.",
                        )
                    )
        return problems

    async def _providers(self) -> list[Problem]:
        now = self._clock()
        today = await self._day(now)
        history: dict[str, int] = {}
        for i in range(1, 7):
            for field, value in (await self._day(now - timedelta(days=i))).items():
                history[field] = history.get(field, 0) + value
        problems = []
        for op in sorted({f.rsplit(":", 1)[0] for f in today if f.endswith(":req")}):
            requests = today.get(f"{op}:req", 0)
            errors = today.get(f"{op}:err", 0)
            if requests >= MIN_REQUESTS and errors / requests >= ERROR_SHARE:
                problems.append(
                    Problem(
                        f"provider_errors:{op}",
                        f"Джерело {op}: {errors} помилок з {requests} запитів за добу.",
                    )
                )
            past = history.get(f"{op}:req", 0)
            if requests >= MIN_REQUESTS and past >= MIN_REQUESTS:
                avg_today = today.get(f"{op}:ms", 0) / requests
                avg_past = history.get(f"{op}:ms", 0) / past
                if avg_today > SLOW_MIN_MS and avg_today > SLOW_FACTOR * avg_past:
                    problems.append(
                        Problem(
                            f"provider_slow:{op}",
                            f"Джерело {op} сповільнилось: {avg_today / 1000:.1f} с проти "
                            f"{avg_past / 1000:.1f} с у середньому за тиждень.",
                        )
                    )
        blocked = sum(v for f, v in today.items() if f.startswith("ratelimit:"))
        if blocked >= self._settings.ops_rate_limit_spike:
            problems.append(
                Problem(
                    "rate_limit_spike",
                    f"Сплеск відмов через ліміти запитів: {blocked} за добу — схоже на бота.",
                )
            )
        return problems

    async def _llm(self) -> list[Problem]:
        day, month = await self._guard.spent_usd()
        problems = []
        for period, used, limit in (
            ("day", day, self._settings.llm_budget_daily_usd),
            ("month", month, self._settings.llm_budget_monthly_usd),
        ):
            if limit and used >= limit * LLM_WARN_SHARE:
                problems.append(
                    Problem(
                        f"llm_budget:{period}",
                        f"Витрати ШІ: ${used:.2f} з ${limit} за "
                        f"{'добу' if period == 'day' else 'місяць'}.",
                    )
                )
        return problems

    async def _day(self, when: datetime) -> dict[str, int]:
        raw = await self._redis.hgetall(f"{STATS_PREFIX}:{when:%Y-%m-%d}")  # type: ignore[misc]
        return {(k.decode() if isinstance(k, bytes) else str(k)): int(v) for k, v in raw.items()}

    async def _first(self, key: str) -> bool:
        try:
            return bool(await self._redis.set(f"ops:alerted:{key}", 1, nx=True, ex=REPEAT_AFTER_S))
        except (RedisError, OSError):
            return True

    async def _notify(self, problem: Problem) -> None:
        text = f"SkyPack: {problem.text}"
        log.warning("ops_watch.problem", key=problem.key)
        chat = self._settings.ops_telegram_chat_id
        if chat is not None:
            try:
                await self._telegram.send_message(chat, text)
            except Exception as exc:
                log.warning("ops_watch.telegram_failed", error=type(exc).__name__)
        email = self._settings.ops_alert_email
        if email:
            try:
                await self._mailer.send(email, "SkyPack: технічне сповіщення", text)
            except Exception as exc:
                log.warning("ops_watch.email_failed", error=type(exc).__name__)
