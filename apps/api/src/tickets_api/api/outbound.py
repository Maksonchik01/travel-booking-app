import structlog
from fastapi import APIRouter, Depends, Request, Response

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.outbound import ClickIn
from tickets_api.repositories.outbound_clicks import record_click

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/outbound", tags=["outbound"])


@router.post(
    "/clicks",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(rate_limit("clicks"))],
)
async def log_click(click: ClickIn, request: Request) -> Response:
    """Облік переходу на партнера (для `/ops/summary`). Редирект від цього не залежить.

    Збій БД — 503 без винятку назовні: веб викликає це вже після редиректу.
    """
    try:
        await record_click(request.app.state.sessionmaker, click)
    except Exception as exc:
        log.warning("outbound.click_failed", error=type(exc).__name__)
        return Response(status_code=503)
    return Response(status_code=204)
