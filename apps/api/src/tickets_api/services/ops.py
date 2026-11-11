"""Зведення для власника (`GET /ops/summary`): квота SerpApi, витрати LLM, кліки, активність,
охоплення пошуку джерелами.

Лише агрегати — без email, токенів чи текстів. Кожна частина незалежна: збій SerpApi чи БД
дає `None` у своїй секції і рядок у `problems`, а не помилку всього зведення.
"""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import structlog
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.core.config import Settings
from tickets_api.db.models import (
    Alert,
    AnalyticsEvent,
    LLMUsage,
    OutboundClick,
    PriceObservation,
    User,
)
from tickets_api.providers.budget import PERIODS, ApiMeter, Period
from tickets_api.repositories.search_coverage import read_coverage

log = structlog.get_logger(__name__)

# Account API (https://serpapi.com/account-api) квоту не витрачає. Беремо лише лічильники:
# у відповіді є й api_key та email — їх не повертаємо.
SERPAPI_FIELDS = (
    "searches_per_month",
    "this_month_usage",
    "plan_searches_left",
    "total_searches_left",
    "this_hour_searches",
)


class SerpApiQuota(BaseModel):
    searches_per_month: int | None = None
    this_month_usage: int | None = None
    plan_searches_left: int | None = None
    total_searches_left: int | None = None
    this_hour_searches: int | None = None


class LLMSpend(BaseModel):
    calls_24h: int
    errors_24h: int
    cost_usd_24h: Decimal
    cost_usd_30d: Decimal


class Clicks(BaseModel):
    total_24h: int
    total_7d: int
    by_source_7d: dict[str, int]


class Activity(BaseModel):
    price_observations_24h: dict[str, int]
    """Скільки цін записано за добу — за джерелом (живий пульс провайдерів)."""
    users: int
    active_alerts: int


class Usage(BaseModel):
    """Анонімні події за 7 днів (модуль 19): частоти й воронка пошуку за режимами."""

    events_7d: dict[str, int]
    searches_7d: dict[str, dict[str, int]]
    """режим → {started, succeeded, empty, failed}."""


class SourceStats(BaseModel):
    statuses: dict[str, int]
    """статус (ok / error / timeout / rate_limited / unsupported) → скільки пошуків."""
    received: int
    shown: int


class SearchCoverageSummary(BaseModel):
    """Охоплення пошуку перельотів за 7 днів (модуль 22.8): як відповідали джерела."""

    searches_7d: int
    multi_seller_flights_7d: int
    """Рейсів, що продавались у кількох продавців (порівняння цін спрацювало)."""
    sources: dict[str, SourceStats]


class AccountSpend(BaseModel):
    """Платний рахунок (ADR 0055): використання й ліміти SkyPack у його одиницях."""

    used: dict[Period, int]
    limits: dict[Period, int | None]
    units_per_request: int
    cost_usd_today: Decimal
    cost_usd_month: Decimal
    """Оцінка за ціною одиниці з конфігу (на безкоштовному тарифі фактично $0)."""
    near_limit: bool
    """Добове чи місячне використання — не менше за частку попередження."""


class OperationStats(BaseModel):
    requests: int
    ok: int
    errors: int
    blocked: int
    """Не зроблено: бюджет SkyPack вичерпано."""
    avg_ms: int | None


class CacheStats(BaseModel):
    hits: int
    shared: int
    """Приєднались до однакового запиту, що вже йшов (до джерела не ходили)."""
    misses: int
    hit_rate: float | None
    """Частка звернень, що обійшлися без нового запиту до джерела (ADR 0058)."""


class ApiSpend(BaseModel):
    accounts: dict[str, AccountSpend]
    operations_7d: dict[str, OperationStats]
    """`рахунок:операція` → запити за 7 днів (Travelpayouts теж — лише облік)."""
    searches_7d: dict[str, dict[str, int]]
    """вид пошуку → {ok, empty, avg_ms} (avg_ms — середній час відповіді API)."""
    cost_usd_7d: Decimal
    cost_per_successful_search_usd_7d: Decimal | None
    """Оцінка всіх платних запитів за 7 днів / пошуків, що щось знайшли."""
    cache_7d: dict[str, CacheStats] = {}
    """джерело → влучання й промахи кешу за 7 днів."""
    rate_limited_7d: dict[str, int] = {}
    """кошик ліміту → відмов 429 за 7 днів (ADR 0062)."""


class OpsSummary(BaseModel):
    generated_at: datetime
    serpapi: SerpApiQuota | None
    llm: LLMSpend | None
    clicks: Clicks | None
    activity: Activity | None
    usage: Usage | None = None
    coverage: SearchCoverageSummary | None = None
    api_spend: ApiSpend | None = None
    problems: list[str]


SEARCH_OUTCOMES = {
    "search_started": "started",
    "search_succeeded": "succeeded",
    "search_empty": "empty",
    "search_failed": "failed",
}


async def usage_summary(sessionmaker: async_sessionmaker[AsyncSession], now: datetime) -> Usage:
    week = now - timedelta(days=7)
    async with sessionmaker() as session:
        rows = (
            await session.execute(
                select(AnalyticsEvent.name, AnalyticsEvent.props, func.count(AnalyticsEvent.id))
                .where(AnalyticsEvent.created_at >= week)
                .group_by(AnalyticsEvent.name, AnalyticsEvent.props)
            )
        ).all()
    events: dict[str, int] = {}
    searches: dict[str, dict[str, int]] = {}
    for name, props, count in rows:
        events[name] = events.get(name, 0) + int(count)
        if name in SEARCH_OUTCOMES:
            mode = str(json.loads(props or "{}").get("mode", "unknown"))
            outcome = searches.setdefault(mode, dict.fromkeys(SEARCH_OUTCOMES.values(), 0))
            outcome[SEARCH_OUTCOMES[name]] += int(count)
    return Usage(events_7d=events, searches_7d=searches)


def coverage_summary(totals: dict[str, int]) -> SearchCoverageSummary:
    sources: dict[str, SourceStats] = {}
    for field, value in totals.items():
        provider, sep, part = field.rpartition(":")
        if not sep:
            continue
        stats = sources.setdefault(provider, SourceStats(statuses={}, received=0, shown=0))
        if part in ("received", "shown"):
            setattr(stats, part, getattr(stats, part) + value)
        else:
            stats.statuses[part] = stats.statuses.get(part, 0) + value
    return SearchCoverageSummary(
        searches_7d=totals.get("searches", 0),
        multi_seller_flights_7d=totals.get("multi_seller_flights", 0),
        sources=dict(sorted(sources.items())),
    )


async def serpapi_quota(settings: Settings, http: httpx.AsyncClient) -> SerpApiQuota | None:
    if settings.serpapi_key is None:
        return None
    response = await http.get(
        f"{settings.serpapi_base_url.rstrip('/')}/account.json",
        params={"api_key": settings.serpapi_key.get_secret_value()},
        timeout=10.0,
    )
    response.raise_for_status()
    data = response.json()
    return SerpApiQuota(**{k: data[k] for k in SERPAPI_FIELDS if isinstance(data.get(k), int)})


async def database_summary(
    sessionmaker: async_sessionmaker[AsyncSession], now: datetime
) -> tuple[LLMSpend, Clicks, Activity]:
    day, week, month = now - timedelta(days=1), now - timedelta(days=7), now - timedelta(days=30)
    async with sessionmaker() as session:
        llm_day = (
            await session.execute(
                select(
                    func.count(LLMUsage.id),
                    func.count(LLMUsage.id).filter(LLMUsage.status != "ok"),
                    func.coalesce(func.sum(LLMUsage.cost_usd), 0),
                ).where(LLMUsage.created_at >= day)
            )
        ).one()
        llm_month = await session.scalar(
            select(func.coalesce(func.sum(LLMUsage.cost_usd), 0)).where(
                LLMUsage.created_at >= month
            )
        )
        clicks = (
            await session.execute(
                select(OutboundClick.source, func.count(OutboundClick.id))
                .where(OutboundClick.created_at >= week)
                .group_by(OutboundClick.source)
            )
        ).all()
        clicks_day = await session.scalar(
            select(func.count(OutboundClick.id)).where(OutboundClick.created_at >= day)
        )
        prices = (
            await session.execute(
                select(PriceObservation.source, func.count(PriceObservation.id))
                .where(PriceObservation.collected_at >= day)
                .group_by(PriceObservation.source)
            )
        ).all()
        users = await session.scalar(select(func.count(User.id)))
        alerts = await session.scalar(select(func.count(Alert.id)).where(Alert.status == "active"))
    by_source = {source: int(count) for source, count in clicks}
    return (
        LLMSpend(
            calls_24h=int(llm_day[0]),
            errors_24h=int(llm_day[1]),
            cost_usd_24h=Decimal(llm_day[2] or 0),
            cost_usd_30d=Decimal(llm_month or 0),
        ),
        Clicks(
            total_24h=int(clicks_day or 0), total_7d=sum(by_source.values()), by_source_7d=by_source
        ),
        Activity(
            price_observations_24h={source: int(count) for source, count in prices},
            users=int(users or 0),
            active_alerts=int(alerts or 0),
        ),
    )


async def api_spend(meter: ApiMeter, warn_share: float) -> ApiSpend:
    totals = await meter.stats(7)
    accounts: dict[str, AccountSpend] = {}
    cost_7d = Decimal(0)
    for name in meter.budgets:
        budget = await meter.effective(name)
        used = await meter.usage(name)
        limits = {p: budget.limit(p) for p in PERIODS}
        units_7d = sum(
            v for k, v in totals.items() if k.startswith(f"{name}:") and k.endswith(":units")
        )
        cost_7d += units_7d * budget.unit_cost_usd
        accounts[name] = AccountSpend(
            used=used,
            limits=limits,
            units_per_request=budget.units_per_request,
            cost_usd_today=used["day"] * budget.unit_cost_usd,
            cost_usd_month=used["month"] * budget.unit_cost_usd,
            near_limit=any(
                (limit := limits[p]) is not None and limit > 0 and used[p] >= limit * warn_share
                for p in ("day", "month")
            ),
        )
    operations: dict[str, OperationStats] = {}
    searches: dict[str, dict[str, int]] = {}
    cache: dict[str, CacheStats] = {}
    limited: dict[str, int] = {}
    for key in {k.rsplit(":", 1)[0] for k in totals}:
        account, operation = key.split(":", 1)
        if account == "cache":
            hits, misses = totals.get(f"{key}:hit", 0), totals.get(f"{key}:miss", 0)
            shared = totals.get(f"{key}:shared", 0)
            served = hits + shared
            cache[operation] = CacheStats(
                hits=hits,
                shared=shared,
                misses=misses,
                hit_rate=round(served / (served + misses), 3) if served + misses else None,
            )
            continue
        if account == "search":
            ok, empty = totals.get(f"{key}:ok", 0), totals.get(f"{key}:empty", 0)
            searches[operation] = {
                "ok": ok,
                "empty": empty,
                "avg_ms": totals.get(f"{key}:ms", 0) // (ok + empty) if ok + empty else 0,
            }
            continue
        if account == "ratelimit":
            limited[operation] = totals.get(f"{key}:blocked", 0)
            continue
        requests = totals.get(f"{key}:req", 0)
        operations[key] = OperationStats(
            requests=requests,
            ok=totals.get(f"{key}:ok", 0),
            errors=totals.get(f"{key}:err", 0),
            blocked=totals.get(f"{key}:blocked", 0),
            avg_ms=totals.get(f"{key}:ms", 0) // requests if requests else None,
        )
    successful = sum(s["ok"] for s in searches.values())
    return ApiSpend(
        accounts=accounts,
        operations_7d=dict(sorted(operations.items())),
        searches_7d=searches,
        cache_7d=dict(sorted(cache.items())),
        rate_limited_7d=dict(sorted(limited.items())),
        cost_usd_7d=cost_7d,
        cost_per_successful_search_usd_7d=(
            (cost_7d / successful).quantize(Decimal("0.0001")) if successful else None
        ),
    )


async def build_summary(
    settings: Settings,
    http: httpx.AsyncClient,
    sessionmaker: async_sessionmaker[AsyncSession],
    now: datetime | None = None,
    redis: Redis | None = None,
    meter: ApiMeter | None = None,
) -> OpsSummary:
    now = now or datetime.now(UTC)
    problems: list[str] = []
    serpapi: SerpApiQuota | None = None
    try:
        serpapi = await serpapi_quota(settings, http)
    except Exception as exc:
        log.warning("ops.serpapi_failed", error=type(exc).__name__)
        problems.append(f"serpapi: {type(exc).__name__}")
    llm = clicks = activity = None
    try:
        llm, clicks, activity = await database_summary(sessionmaker, now)
    except Exception as exc:
        log.warning("ops.database_failed", error=type(exc).__name__)
        problems.append(f"database: {type(exc).__name__}")
    usage = None
    try:
        usage = await usage_summary(sessionmaker, now)
    except Exception as exc:
        log.warning("ops.usage_failed", error=type(exc).__name__)
        problems.append(f"usage: {type(exc).__name__}")
    coverage = None
    if redis is not None:
        try:
            coverage = coverage_summary(await read_coverage(redis, now))
        except Exception as exc:
            log.warning("ops.coverage_failed", error=type(exc).__name__)
            problems.append(f"coverage: {type(exc).__name__}")
    spend = None
    if meter is not None:
        try:
            spend = await api_spend(meter, settings.api_budget_warn_share)
        except Exception as exc:
            log.warning("ops.api_spend_failed", error=type(exc).__name__)
            problems.append(f"api_spend: {type(exc).__name__}")
    return OpsSummary(
        generated_at=now,
        api_spend=spend,
        coverage=coverage,
        serpapi=serpapi,
        llm=llm,
        clicks=clicks,
        activity=activity,
        usage=usage,
        problems=problems,
    )
