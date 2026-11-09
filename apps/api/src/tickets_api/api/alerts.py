from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from tickets_api.api.deps import OptionalUser
from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.alerts import AlertCreate, AlertEdit, AlertEventOut, AlertView
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


@router.post(
    "", response_model=AlertCreated, status_code=201, dependencies=[Depends(rate_limit("auth"))]
)
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


@router.post("/pause", response_model=AlertView)
async def pause_alert(body: TokenBody, request: Request) -> AlertView:
    """Призупинити: не перевіряємо й не пишемо, доки не відновите."""
    return _found(await _service(request).pause(body.token))


@router.post("/resume", response_model=AlertView)
async def resume_alert(body: TokenBody, request: Request) -> AlertView:
    return _found(await _service(request).resume(body.token))


class EditBody(TokenBody):
    edit: AlertEdit


@router.post("/edit", response_model=AlertView)
async def edit_alert(body: EditBody, request: Request) -> AlertView:
    """Змінити дати, людей, багаж чи умову (маршрут і канал — лише новою підпискою)."""
    try:
        return _found(await _service(request).update(body.token, body.edit))
    except AlertError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/delete", status_code=204)
async def delete_alert(body: TokenBody, request: Request) -> Response:
    if not await _service(request).delete(body.token):
        raise HTTPException(status_code=404, detail="alert not found")
    return Response(status_code=204)


@router.get("/history", response_model=list[AlertEventOut])
async def alert_history(
    request: Request, token: str = Query(min_length=16, max_length=64)
) -> list[AlertEventOut]:
    """Історія спрацювань і змін (без рядових перевірок)."""
    events = await _service(request).history(token)
    if events is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return events


def _found(view: AlertView | None) -> AlertView:
    if view is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return view
