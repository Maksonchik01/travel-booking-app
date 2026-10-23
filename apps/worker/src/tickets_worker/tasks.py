from typing import Any

import structlog

log = structlog.get_logger(__name__)


async def ping(ctx: dict[str, Any]) -> str:
    """Тестова задача: підтверджує, що воркер приймає задачі з черги."""
    log.info("worker.ping", job_id=ctx.get("job_id"))
    return "pong"
