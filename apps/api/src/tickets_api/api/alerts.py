from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from tickets_api.api.deps import OptionalUser
from tickets_api.domain.alerts import AlertCreate, AlertView
from tickets_api.services.alerts import AlertCreated, AlertError, AlertService, ChannelStatus

router = APIRouter(prefix="/alerts", tags=["alerts"])


class TokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=16, max_length=64)


def _service(request: Request) -> AlertService:
    service: AlertService = request.app.state.alerts
    return service


@router.get("/channels", response_model=ChannelStatus)
async def channels(request: Request) -> ChannelStatus:
    """Які канали працюють наживо, а які — mock (лише лог, без ключів)."""
    return _service(request).channels()


@router.post("", response_model=AlertCreated, status_code=201)
async def create_alert(body: AlertCreate, request: Request, user: OptionalUser) -> AlertCreated:
    """Нова підписка (pending): підтвердження — /start у боті або посилання з листа.

    Якщо запит від користувача з сесією — підписка з'явиться в його кабінеті.
    """
    try:
        return await _service(request).create(body, user.id if user else None)
    except AlertError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/manage", response_model=AlertView)
async def manage_alert(
    request: Request, token: str = Query(min_length=16, max_length=64)
) -> AlertView:
    view = await _service(request).view(token)
    if view is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return view


@router.post("/confirm", response_model=AlertView)
async def confirm_alert(body: TokenBody, request: Request) -> AlertView:
    """Підтвердження email-підписки (подвійна згода)."""
    view = await _service(request).confirm_email(body.token)
    if view is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return view


@router.post("/stop", response_model=AlertView)
async def stop_alert(body: TokenBody, request: Request) -> AlertView:
    view = await _service(request).stop(body.token)
    if view is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return view
