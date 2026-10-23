from typing import Any, ClassVar

from arq.connections import RedisSettings
from tickets_api.core.config import get_settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry

from tickets_worker.tasks import ping

_settings = get_settings()


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging(_settings.log_level, json=_settings.log_json)
    init_sentry(_settings)


class WorkerSettings:
    """Точка входу ARQ: `arq tickets_worker.settings.WorkerSettings`."""

    functions: ClassVar[list[Any]] = [ping]
    cron_jobs: ClassVar[list[Any]] = []  # перевірка алертів з'явиться на етапі 7
    on_startup = startup
    redis_settings = RedisSettings.from_dsn(_settings.redis_url)
    health_check_interval = 30
