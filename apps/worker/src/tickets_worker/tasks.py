from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.services.alerts import AlertService
from tickets_api.services.maintenance import prune_expired
from tickets_api.services.ops_watch import OpsWatch
from tickets_api.services.telegram_bot import TelegramBotService

log = structlog.get_logger(__name__)


async def ping(ctx: dict[str, Any]) -> str:
    """Тестова задача: підтверджує, що воркер приймає задачі з черги."""
    log.info("worker.ping", job_id=ctx.get("job_id"))
    return "pong"


async def check_alerts(ctx: dict[str, Any]) -> int:
    """Перевірити всі активні підписки на ціну й надіслати сповіщення (ADR 0010)."""
    alerts: AlertService = ctx["alerts"]
    sent = await alerts.check_all()
    log.info("worker.alerts_checked", notifications=sent)
    return sent


async def poll_telegram(ctx: dict[str, Any]) -> int:
    """Забрати нові повідомлення й натискання кнопок бота і відповісти."""
    bot: TelegramBotService = ctx["bot"]
    return await bot.poll()


async def prune_database(ctx: dict[str, Any]) -> int:
    """Раз на добу: прострочені сесії входу й токени з листів (модуль 16)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    return await prune_expired(sessionmaker)


async def watch_ops(ctx: dict[str, Any]) -> int:
    """Раз на 15 хв: технічні проблеми → сповіщення власнику (ADR 0062). Повертає їх кількість."""
    watch: OpsWatch = ctx["ops_watch"]
    return len(await watch.run())
