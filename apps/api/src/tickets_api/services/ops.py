"""Зведення для власника (`GET /ops/summary`): квота SerpApi, витрати LLM, кліки, активність.

Лише агрегати — без email, токенів чи текстів. Кожна частина незалежна: збій SerpApi чи БД
дає `None` у своїй секції і рядок у `problems`, а не помилку всього зведення.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import structlog
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.core.config import Settings
from tickets_api.db.models import Alert, LLMUsage, OutboundClick, PriceObservation, User

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


class OpsSummary(BaseModel):
    generated_at: datetime
    serpapi: SerpApiQuota | None
    llm: LLMSpend | None
    clicks: Clicks | None
    activity: Activity | None
    problems: list[str]


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


async def build_summary(
    settings: Settings,
    http: httpx.AsyncClient,
    sessionmaker: async_sessionmaker[AsyncSession],
    now: datetime | None = None,
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
    return OpsSummary(
        generated_at=now,
        serpapi=serpapi,
        llm=llm,
        clicks=clicks,
        activity=activity,
        problems=problems,
    )
