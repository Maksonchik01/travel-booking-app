import structlog
from fastapi import APIRouter, Depends, Request, Response

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.analytics import EventIn
from tickets_api.repositories.analytics import record_event

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/events", tags=["analytics"])


@router.post(
    "", status_code=204, response_class=Response, dependencies=[Depends(rate_limit("events"))]
)
async def log_event(event: EventIn, request: Request) -> Response:
    """Анонімна подія використання (модуль 19). Нічого не повертає й нічого не ламає: збій
    БД — 503, сторінка про це не дізнається."""
    try:
        await record_event(request.app.state.sessionmaker, event)
    except Exception as exc:
        log.warning("analytics.record_failed", error=type(exc).__name__)
        return Response(status_code=503)
    return Response(status_code=204)
