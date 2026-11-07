from typing import Any

import structlog
from tickets_api.services.alerts import AlertService

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
    """Забрати нові повідомлення бота (/start <код>, /list, /stop) і відповісти."""
    alerts: AlertService = ctx["alerts"]
    return await alerts.poll_telegram()
