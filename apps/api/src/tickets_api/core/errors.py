"""Збій залежності (база, мережа до неї) → 503 `unavailable` замість голого 500 (V3, етап 7).

Пошук від бази не залежить (історія цін пишеться «з найкращих намірів»), а кабінет, вхід,
підписки й публічна поїздка — залежать. Їм — зрозуміла відповідь: веб показує «тимчасово
недоступно» з повтором і не вважає людину такою, що вийшла (`account/error.tsx`).
"""

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

log = structlog.get_logger(__name__)

RETRY_AFTER_S = 30
# Лише збої з'єднання: порушення обмежень (IntegrityError) — не «тимчасово недоступно».
DEPENDENCY_ERRORS: tuple[type[Exception], ...] = (
    OperationalError,
    InterfaceError,
    ConnectionError,
    TimeoutError,
    OSError,
)


async def _unavailable(request: Request, exc: Exception) -> JSONResponse:
    log.warning("dependency.unavailable", path=request.url.path, error=type(exc).__name__)
    return JSONResponse(
        {"detail": "unavailable"},
        status_code=503,
        headers={"Retry-After": str(RETRY_AFTER_S)},
    )


def register_dependency_errors(app: FastAPI) -> None:
    for error in DEPENDENCY_ERRORS:
        app.add_exception_handler(error, _unavailable)
