from fastapi import APIRouter, Query, Request, Response

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
    SessionInfo,
)
from tickets_api.domain.chats import (
    ChatConversationBody,
    ChatConversationOut,
    ChatSyncBody,
    ChatSyncState,
    ConversationId,
)
from tickets_api.domain.favorites import FavoriteBody, FavoriteOut, FavoritesImport
from tickets_api.domain.notify import NotifyPrefs
from tickets_api.domain.profile import LocaleBody, PreferencesBody, SearchPrefs
from tickets_api.domain.saved_trips import (
    SavedTripBody,
    SavedTripOut,
    SavedTripPatch,
    SavedTripsImport,
)
from tickets_api.services.accounts import MAX_AVATAR_BYTES, AccountError

router = APIRouter(prefix="/account", tags=["account"])


@router.get("", response_model=Account)
async def get_account(user: CurrentUser, service: Service) -> Account:
    return await service.account(user)


@router.patch("/profile", response_model=Account)
async def update_profile(body: ProfileBody, user: CurrentUser, service: Service) -> Account:
    await service.update_profile(user, body.first_name, body.last_name)
    refreshed = await service.user_by_id(user.id)
    return await service.account(refreshed)


@router.put("/preferences", response_model=Account)
async def update_preferences(body: PreferencesBody, user: CurrentUser, service: Service) -> Account:
    """Мова, валюта, країна, домашній і улюблені аеропорти (форма надсилає все разом)."""
    try:
        await service.update_preferences(user, body)
    except AccountError as exc:
        raise account_error(exc) from exc
    return await service.account(await service.user_by_id(user.id))


@router.put("/locale", status_code=204)
async def set_locale(body: LocaleBody, user: CurrentUser, service: Service) -> Response:
    """Перемикач мови в шапці: запам'ятовуємо вибір і в профілі (інші пристрої)."""
    await service.set_locale(user, body.locale)
    return Response(status_code=204)


@router.put("/search-preferences", response_model=Account)
async def save_search_prefs(body: SearchPrefs, user: CurrentUser, service: Service) -> Account:
    """Особисті налаштування пошуку — значення за замовчуванням для нових пошуків."""
    await service.save_search_prefs(user, body)
    return await service.account(await service.user_by_id(user.id))


@router.get(
    "/avatar",
    responses={200: {"content": {"image/png": {}, "image/jpeg": {}, "image/webp": {}}}},
    response_class=Response,
)
async def get_avatar(user: CurrentUser, service: Service) -> Response:
    avatar = await service.avatar(user.id)
    if avatar is None:
        return Response(status_code=404)
    content_type, data = avatar
    # Адреса у вебі містить версію (avatar_version) — тож кешувати можна довго.
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/avatar", response_model=Account)
async def upload_avatar(request: Request, user: CurrentUser, service: Service) -> Account:
    """Тіло — саме зображення (PNG/JPEG/WebP, до 300 КБ); тип визначаємо за вмістом."""
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_AVATAR_BYTES:
            raise account_error(AccountError("image_too_large"))
    try:
        await service.set_avatar(user, bytes(data))
    except AccountError as exc:
        raise account_error(exc) from exc
    return await service.account(await service.user_by_id(user.id))


@router.delete("/avatar", response_model=Account)
async def delete_avatar(user: CurrentUser, service: Service) -> Account:
    await service.delete_avatar(user)
    return await service.account(await service.user_by_id(user.id))


@router.put("/notifications", response_model=Account)
async def save_notify_prefs(body: NotifyPrefs, user: CurrentUser, service: Service) -> Account:
    """Налаштування сповіщень для підписок акаунта (канали, частота, тиша, категорії)."""
    await service.save_notify_prefs(user, body)
    return await service.account(await service.user_by_id(user.id))


@router.get("/sessions", response_model=list[SessionInfo])
async def sessions(user: CurrentUser, service: Service, token: Token) -> list[SessionInfo]:
    return await service.sessions(user, token)


@router.delete("/sessions/{session_id}", status_code=204)
async def end_session(session_id: str, user: CurrentUser, service: Service) -> Response:
    try:
        await service.end_session(user, session_id)
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=204)


@router.post("/sessions/end-others", response_model=dict[str, int])
async def end_other_sessions(user: CurrentUser, service: Service, token: Token) -> dict[str, int]:
    """Вийти на всіх інших пристроях; поточна сесія лишається."""
    return {"ended": await service.end_other_sessions(user, token or "")}


@router.delete("/chats", status_code=204)
async def clear_chats(user: CurrentUser, service: Service) -> Response:
    await service.clear_chats(user)
    return Response(status_code=204)


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


@router.get("/favorites", response_model=list[FavoriteOut])
async def favorites(user: CurrentUser, service: Service) -> list[FavoriteOut]:
    return await service.favorites(user)


@router.post("/favorites", response_model=list[FavoriteOut])
async def add_favorite(
    body: FavoriteBody, user: CurrentUser, service: Service
) -> list[FavoriteOut]:
    """«В обране»: знімок об'єкта з ціною на момент збереження. Повтор — без дубля."""
    try:
        return await service.add_favorites(user, [body])
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/favorites/import", response_model=list[FavoriteOut])
async def import_favorites(
    body: FavoritesImport, user: CurrentUser, service: Service
) -> list[FavoriteOut]:
    """Обране гостя з браузера — до акаунта після входу."""
    try:
        return await service.add_favorites(user, body.items)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/favorites", status_code=204)
async def delete_favorite(
    user: CurrentUser, service: Service, key: str = Query(min_length=1, max_length=200)
) -> Response:
    await service.delete_favorite(user, key)
    return Response(status_code=204)


@router.get("/chats", response_model=ChatSyncState)
async def chats(user: CurrentUser, service: Service) -> ChatSyncState:
    """Розмови з помічником — лише якщо синхронізацію увімкнено (згода)."""
    return await service.chats(user)


@router.put("/chats/sync", response_model=ChatSyncState)
async def set_chat_sync(body: ChatSyncBody, user: CurrentUser, service: Service) -> ChatSyncState:
    """Увімкнути / вимкнути синхронізацію. Вимкнення видаляє розмови з сервера."""
    return await service.set_chat_sync(user, body.enabled)


@router.put("/chats/{conversation_id}", response_model=ChatConversationOut)
async def save_chat(
    conversation_id: ConversationId,
    body: ChatConversationBody,
    user: CurrentUser,
    service: Service,
) -> ChatConversationOut:
    try:
        return await service.save_chat(user, conversation_id, body)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/chats/{conversation_id}", status_code=204)
async def delete_chat(
    conversation_id: ConversationId, user: CurrentUser, service: Service
) -> Response:
    await service.delete_chat(user, conversation_id)
    return Response(status_code=204)


@router.get("/trips", response_model=list[SavedTripOut])
async def saved_trips(user: CurrentUser, service: Service) -> list[SavedTripOut]:
    return await service.saved_trips(user)


@router.post("/trips", response_model=SavedTripOut, status_code=201)
async def save_trip(body: SavedTripBody, user: CurrentUser, service: Service) -> SavedTripOut:
    """«Зберегти поїздку» і «Створити копію»: запит з вибором + знімок цін (історичних)."""
    try:
        return (await service.save_trips(user, [body]))[0]
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/trips/import", response_model=list[SavedTripOut])
async def import_trips(
    body: SavedTripsImport, user: CurrentUser, service: Service
) -> list[SavedTripOut]:
    """Поїздки гостя з браузера — до акаунта після входу."""
    try:
        await service.save_trips(user, body.items)
    except AccountError as exc:
        raise account_error(exc) from exc
    return await service.saved_trips(user)


@router.put("/trips/{trip_id}", response_model=SavedTripOut)
async def update_trip(
    trip_id: str, body: SavedTripBody, user: CurrentUser, service: Service
) -> SavedTripOut:
    try:
        return await service.update_trip(user, trip_id, body)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.patch("/trips/{trip_id}", response_model=SavedTripOut)
async def patch_trip(
    trip_id: str, body: SavedTripPatch, user: CurrentUser, service: Service
) -> SavedTripOut:
    """Назва чи статус поїздки (чернетка / запланована / архівна)."""
    try:
        return await service.patch_trip(user, trip_id, body)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/trips/{trip_id}/share", response_model=SavedTripOut)
async def share_trip(trip_id: str, user: CurrentUser, service: Service) -> SavedTripOut:
    """Увімкнути публічне посилання на поїздку (модуль 20.2)."""
    try:
        return await service.share_trip(user, trip_id, enabled=True)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/trips/{trip_id}/share", response_model=SavedTripOut)
async def unshare_trip(trip_id: str, user: CurrentUser, service: Service) -> SavedTripOut:
    """Вимкнути публічне посилання: старе більше не відкривається."""
    try:
        return await service.share_trip(user, trip_id, enabled=False)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.delete("/trips/{trip_id}", status_code=204)
async def delete_trip(trip_id: str, user: CurrentUser, service: Service) -> Response:
    await service.delete_trip(user, trip_id)
    return Response(status_code=204)


@router.get("/alerts", response_model=list[AccountAlert])
async def my_alerts(user: CurrentUser, service: Service) -> list[AccountAlert]:
    return await service.alerts(user)
