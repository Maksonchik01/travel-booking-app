import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from tickets_api.core.config import Settings
from tickets_api.providers.budget import ApiMeter, Period
from tickets_api.services.ops import OpsSummary, build_summary

router = APIRouter(prefix="/ops", tags=["ops"])


def owner(request: Request, x_internal_key: Annotated[str | None, Header()] = None) -> None:
    """Доступ власника — заголовок `X-Internal-Key` = INTERNAL_API_KEY (порівняння за сталий
    час). Без ключа в конфігу — 404 (ендпоінтів наче немає), з неправильним — 401."""
    settings: Settings = request.app.state.settings
    if settings.internal_api_key is None:
        raise HTTPException(status_code=404, detail="not_found")
    expected = settings.internal_api_key.get_secret_value().encode()
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected):
        raise HTTPException(status_code=401, detail="not_authenticated")


class BudgetLimit(BaseModel):
    account: str = Field(pattern=r"^(serpapi|scrapedo)$")
    period: Period
    limit: int | None = Field(default=None, ge=0, le=10_000_000)
    """None — без ліміту."""
    reset: bool = False
    """True — повернути значення з конфігу (.env)."""


@router.put("/budgets", status_code=204, dependencies=[Depends(owner)])
async def set_budget(body: BudgetLimit, request: Request) -> None:
    """Власник змінює ліміт платного API без редеплою (ADR 0062); діє за ≤ 30 с."""
    meter: ApiMeter = request.app.state.meter
    if body.reset:
        await meter.reset_limit(body.account, body.period)
    else:
        await meter.set_limit(body.account, body.period, body.limit)


@router.get("/summary", response_model=OpsSummary, dependencies=[Depends(owner)])
async def ops_summary(request: Request) -> OpsSummary:
    """Зведення для власника (з бюджетом і витратами платних API, ADR 0055).

    Доступ — заголовок `X-Internal-Key` = INTERNAL_API_KEY.

    Без INTERNAL_API_KEY ендпоінт вимкнений (404), з неправильним ключем — 401.
    """
    settings: Settings = request.app.state.settings
    return await build_summary(
        settings,
        request.app.state.http,
        request.app.state.sessionmaker,
        redis=getattr(request.app.state, "redis", None),
        meter=getattr(request.app.state, "meter", None),
    )
