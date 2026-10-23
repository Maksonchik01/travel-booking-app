import asyncio
from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

router = APIRouter(tags=["health"])

CheckStatus = Literal["ok", "error"]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str


class CheckResult(BaseModel):
    status: CheckStatus
    latency_ms: float | None = None
    error: str | None = None


class ReadinessResponse(BaseModel):
    status: Literal["ok", "degraded"]
    checks: dict[str, CheckResult]


async def check_database(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


async def check_redis(redis: Redis) -> None:
    await redis.ping()


async def _run_check(check: Callable[[], Awaitable[None]], timeout_s: float) -> CheckResult:
    loop = asyncio.get_running_loop()
    started = loop.time()
    try:
        await asyncio.wait_for(check(), timeout=timeout_s)
    except TimeoutError:
        return CheckResult(status="error", error="timeout")
    except Exception as exc:  # будь-яка помилка залежності = "not ready", а не 500
        return CheckResult(status="error", error=type(exc).__name__)
    return CheckResult(status="ok", latency_ms=round((loop.time() - started) * 1000, 1))


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    """Liveness: процес живий. Залежності не перевіряє."""
    return HealthResponse(status="ok", version=request.app.version)


@router.get(
    "/health/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse}},
)
async def ready(request: Request, response: Response) -> ReadinessResponse:
    """Readiness: перевіряє Postgres і Redis. 503, якщо хоч одна залежність недоступна."""
    state = request.app.state
    timeout_s: float = state.settings.readiness_timeout_s
    db_result, redis_result = await asyncio.gather(
        _run_check(lambda: check_database(state.engine), timeout_s),
        _run_check(lambda: check_redis(state.redis), timeout_s),
    )
    checks = {"database": db_result, "redis": redis_result}
    healthy = all(c.status == "ok" for c in checks.values())
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(status="ok" if healthy else "degraded", checks=checks)
