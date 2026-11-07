from fastapi import APIRouter, Query, Response

from tickets_api.api.auth import account_error
from tickets_api.api.deps import CurrentUser, Service, Token
from tickets_api.domain.accounts import (
    Account,
    AccountAlert,
    DeleteAccountBody,
    EmailBody,
    FlightFiltersBody,
    PasswordChangeBody,
    ProfileBody,
    SearchEntryBody,
    SearchEntryOut,
    SearchEntryRename,
)
from tickets_api.services.accounts import AccountError

router = APIRouter(prefix="/account", tags=["account"])


@router.get("", response_model=Account)
async def get_account(user: CurrentUser, service: Service) -> Account:
    return await service.account(user)


@router.patch("/profile", response_model=Account)
async def update_profile(body: ProfileBody, user: CurrentUser, service: Service) -> Account:
    await service.update_profile(user, body.first_name, body.last_name)
    refreshed = await service.user_by_id(user.id)
    return await service.account(refreshed)


@router.put("/flight-filters", response_model=Account)
async def save_flight_filters(
    body: FlightFiltersBody, user: CurrentUser, service: Service
) -> Account:
    """«Зберегти налаштування» фільтрів: веб додає їх до кожного нового пошуку."""
    await service.save_flight_filters(user, body.flight_filters)
    return await service.account(await service.user_by_id(user.id))


@router.post("/email", status_code=202)
async def change_email(body: EmailBody, user: CurrentUser, service: Service) -> Response:
    """Лист із посиланням на НОВУ адресу; основною вона стане після переходу за ним."""
    try:
        await service.request_email(user, body.email)
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=202)


@router.post("/password", status_code=204)
async def change_password(
    body: PasswordChangeBody, user: CurrentUser, service: Service, token: Token
) -> Response:
    try:
        await service.change_password(user, body.current_password, body.new_password, token or "")
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=204)


@router.post("/telegram/link", response_model=dict[str, str])
async def telegram_link(user: CurrentUser, service: Service) -> dict[str, str]:
    """Одноразове (30 хв) посилання в бота, яке прив'яже чат до акаунта."""
    try:
        return {"url": await service.telegram_link_url(user)}
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/telegram", status_code=204)
async def unlink_telegram(user: CurrentUser, service: Service) -> Response:
    await service.unlink_telegram(user)
    return Response(status_code=204)


@router.delete("/google", status_code=204)
async def unlink_google(user: CurrentUser, service: Service) -> Response:
    try:
        await service.unlink_google(user)
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=204)


@router.post("/delete", status_code=204)
async def delete_account(body: DeleteAccountBody, user: CurrentUser, service: Service) -> Response:
    """Видалення акаунта з усіма даними (GDPR). Потрібен пароль або власний логін."""
    try:
        await service.delete_account(user, body.confirm)
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=204)


@router.get("/searches", response_model=list[SearchEntryOut])
async def searches(
    user: CurrentUser, service: Service, saved: bool = False, limit: int = Query(50, ge=1, le=200)
) -> list[SearchEntryOut]:
    return await service.entries(user, saved=saved, limit=limit)


@router.post("/history", status_code=204)
async def record_search(body: SearchEntryBody, user: CurrentUser, service: Service) -> Response:
    await service.record_search(user, body)
    return Response(status_code=204)


@router.delete("/history", status_code=204)
async def clear_history(user: CurrentUser, service: Service) -> Response:
    await service.clear_history(user)
    return Response(status_code=204)


@router.post("/saved", response_model=SearchEntryOut, status_code=201)
async def save_search(body: SearchEntryBody, user: CurrentUser, service: Service) -> SearchEntryOut:
    try:
        return await service.save_search(user, body)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.patch("/searches/{entry_id}", response_model=SearchEntryOut)
async def rename_search(
    entry_id: str, body: SearchEntryRename, user: CurrentUser, service: Service
) -> SearchEntryOut:
    try:
        return await service.rename_entry(user, entry_id, body.title)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/searches/{entry_id}", status_code=204)
async def delete_search(entry_id: str, user: CurrentUser, service: Service) -> Response:
    await service.delete_entry(user, entry_id)
    return Response(status_code=204)


@router.get("/alerts", response_model=list[AccountAlert])
async def my_alerts(user: CurrentUser, service: Service) -> list[AccountAlert]:
    return await service.alerts(user)
