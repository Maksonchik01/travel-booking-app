"""Лічильники охоплення пошуку перельотів (модуль 22.8) у Redis — для `GET /ops/summary`.

Ключ на добу (`ops:coverage:YYYY-MM-DD`, живе 8 днів), поля — `джерело:статус`,
`джерело:received|shown` і загальні `searches`, `multi_seller_flights`. Лише лічильники:
без маршрутів, дат і людей. Redis недоступний — пропускаємо (діагностика, не пошук).
"""

from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import cast

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tickets_api.services.flight_search import SearchCoverage

log = structlog.get_logger(__name__)

KEY_PREFIX = "ops:coverage"
TTL_S = 8 * 24 * 3600


def coverage_key(day: date) -> str:
    return f"{KEY_PREFIX}:{day.isoformat()}"


class SearchCoverageRecorder:
    def __init__(self, redis: Redis, clock: Callable[[], datetime] | None = None) -> None:
        self._redis = redis
        self._clock = clock or (lambda: datetime.now(UTC))

    async def record(self, coverage: SearchCoverage) -> None:
        key = coverage_key(self._clock().date())
        try:
            pipe = self._redis.pipeline(transaction=False)
            pipe.hincrby(key, "searches", 1)
            pipe.hincrby(key, "multi_seller_flights", coverage.multi_seller_flights)
            for source in coverage.sources:
                pipe.hincrby(key, f"{source.provider}:{source.status}", 1)
                pipe.hincrby(key, f"{source.provider}:received", source.received)
                pipe.hincrby(key, f"{source.provider}:shown", source.shown)
            pipe.expire(key, TTL_S)
            await pipe.execute()
        except (RedisError, OSError) as exc:
            log.warning("coverage.record_failed", error=type(exc).__name__)


async def read_coverage(redis: Redis, now: datetime, days: int = 7) -> dict[str, int]:
    """Сума лічильників за останні `days` днів (включно з сьогодні)."""
    totals: dict[str, int] = {}
    for i in range(days):
        # redis-py типізує hgetall як «або синхронний, або асинхронний» результат.
        raw: dict[bytes, bytes] = await cast(
            Awaitable[dict[bytes, bytes]],
            redis.hgetall(coverage_key((now - timedelta(days=i)).date())),
        )
        for field, value in raw.items():
            name = field.decode() if isinstance(field, bytes) else str(field)
            totals[name] = totals.get(name, 0) + int(value)
    return totals
