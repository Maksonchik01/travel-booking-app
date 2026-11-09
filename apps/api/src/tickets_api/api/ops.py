import hmac
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request

from tickets_api.core.config import Settings
from tickets_api.services.ops import OpsSummary, build_summary

router = APIRouter(prefix="/ops", tags=["ops"])


@router.get("/summary", response_model=OpsSummary)
async def ops_summary(
    request: Request, x_internal_key: Annotated[str | None, Header()] = None
) -> OpsSummary:
    """Зведення для власника. Доступ — заголовок `X-Internal-Key` = INTERNAL_API_KEY.

    Без INTERNAL_API_KEY ендпоінт вимкнений (404), з неправильним ключем — 401.
    """
    settings: Settings = request.app.state.settings
    if settings.internal_api_key is None:
        raise HTTPException(status_code=404, detail="not_found")
    expected = settings.internal_api_key.get_secret_value().encode()
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected):
        raise HTTPException(status_code=401, detail="not_authenticated")
    return await build_summary(
        settings,
        request.app.state.http,
        request.app.state.sessionmaker,
        redis=getattr(request.app.state, "redis", None),
    )
