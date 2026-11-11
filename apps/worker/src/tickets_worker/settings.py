from typing import Any, ClassVar

import httpx
from arq import cron
from arq.connections import RedisSettings
from redis.asyncio import Redis
from tickets_api.core.config import get_settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.llm.metered import LLMSpendGuard
from tickets_api.notifications.factory import build_mailer, build_telegram
from tickets_api.providers.registry import build_meter
from tickets_api.services.alerts_factory import build_alert_service, build_bot_service
from tickets_api.services.ops_watch import OpsWatch

from tickets_worker.tasks import check_alerts, ping, poll_telegram, prune_database, watch_ops

_settings = get_settings()
# Перевірка підписок — кожні ALERT_CHECK_INTERVAL_HOURS годин (о :00); бот — щохвилини.
_CHECK_HOURS = set(range(0, 24, _settings.alert_check_interval_hours))


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging(_settings.log_level, json=_settings.log_json)
    init_sentry(_settings)
    ctx["engine"] = create_engine(_settings.database_url)
    ctx["http"] = httpx.AsyncClient(timeout=_settings.provider_timeout_s)
    ctx["redis_client"] = Redis.from_url(
        _settings.redis_url, socket_timeout=2.0, socket_connect_timeout=2.0
    )
    sessionmaker = create_sessionmaker(ctx["engine"])
    ctx["sessionmaker"] = sessionmaker
    ctx["alerts"] = build_alert_service(
        _settings, http=ctx["http"], redis=ctx["redis_client"], sessionmaker=sessionmaker
    )
    ctx["bot"] = build_bot_service(
        _settings, ctx["alerts"], redis=ctx["redis_client"], sessionmaker=sessionmaker
    )
    await ctx["bot"].setup()  # меню команд у Telegram
    ctx["ops_watch"] = OpsWatch(
        _settings,
        redis=ctx["redis_client"],
        http=ctx["http"],
        meter=build_meter(_settings, ctx["redis_client"]),
        spend_guard=LLMSpendGuard(
            ctx["redis_client"],
            daily_usd=_settings.llm_budget_daily_usd,
            monthly_usd=_settings.llm_budget_monthly_usd,
        ),
        telegram=build_telegram(_settings, ctx["http"]),
        mailer=build_mailer(_settings),
    )


async def shutdown(ctx: dict[str, Any]) -> None:
    await ctx["http"].aclose()
    await ctx["redis_client"].aclose()
    await ctx["engine"].dispose()


class WorkerSettings:
    """Точка входу ARQ: `arq tickets_worker.settings.WorkerSettings`."""

    functions: ClassVar[list[Any]] = [ping, check_alerts, poll_telegram, prune_database, watch_ops]
    cron_jobs: ClassVar[list[Any]] = [
        cron(check_alerts, hour=_CHECK_HOURS, minute={0}, run_at_startup=True),
        # Опитування бота замість webhook: публічна адреса не потрібна.
        cron(poll_telegram, second={0}, unique=True),
        cron(prune_database, hour={3}, minute={30}, unique=True),
        # Технічні сповіщення власнику (ADR 0062): бюджети, збої джерел, доступність API.
        cron(watch_ops, minute={0, 15, 30, 45}, unique=True),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(_settings.redis_url)
    health_check_interval = 30
