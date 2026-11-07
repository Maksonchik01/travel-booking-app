from fastapi import APIRouter, HTTPException, Response

from tickets_api.api.deps import CurrentUser, OptionalUser, Service, Token
from tickets_api.domain.accounts import (
    AuthStatus,
    EmailBody,
    GoogleCallbackBody,
    GoogleStart,
    GoogleStartBody,
    LoginBody,
    PasswordResetBody,
    RegisterBody,
    SessionOut,
    TokenBody,
)
from tickets_api.services.accounts import AccountError

router = APIRouter(prefix="/auth", tags=["auth"])

STATUS = {
    "username_taken": 409,
    "email_taken": 409,
    "google_taken": 409,
    "invalid_credentials": 401,
    "wrong_password": 403,
    "too_many_attempts": 429,
    "invalid_token": 400,
    "google_failed": 400,
    "google_unavailable": 503,
    "last_login_method": 409,
    "limit_reached": 409,
    "not_found": 404,
    "telegram_unavailable": 503,
}


def account_error(exc: AccountError) -> HTTPException:
    return HTTPException(status_code=STATUS.get(exc.code, 400), detail=exc.code)


@router.get("/status", response_model=AuthStatus)
async def auth_status(service: Service) -> AuthStatus:
    return AuthStatus(google=service.google_enabled, email=service.mail_mode)


@router.post("/register", response_model=SessionOut, status_code=201)
async def register(body: RegisterBody, service: Service) -> SessionOut:
    try:
        return await service.register(body)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/login", response_model=SessionOut)
async def login(body: LoginBody, service: Service) -> SessionOut:
    try:
        return await service.login(body.login, body.password)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/logout", status_code=204)
async def logout(service: Service, token: Token, everywhere: bool = False) -> Response:
    if token:
        await service.logout(token, everywhere=everywhere)
    return Response(status_code=204)


@router.post("/google/start", response_model=GoogleStart)
async def google_start(body: GoogleStartBody, service: Service, user: OptionalUser) -> GoogleStart:
    """URL для переходу в Google. Режим link — прив'язати Google до відкритої сесії."""
    if body.mode == "link" and user is None:
        raise HTTPException(status_code=401, detail="not_authenticated")
    try:
        return await service.google_start(body.mode, user.id if user else None)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.post("/google/callback", response_model=SessionOut | None)
async def google_callback(body: GoogleCallbackBody, service: Service) -> SessionOut | None:
    """Код від Google → сесія (вхід) або null (прив'язка до вже відкритої сесії)."""
    try:
        session, _mode = await service.google_callback(body.code, body.state)
    except AccountError as exc:
        raise account_error(exc) from exc
    return session


@router.post("/email/verify", status_code=204)
async def verify_email(body: TokenBody, service: Service) -> Response:
    try:
        await service.verify_email(body.token)
    except AccountError as exc:
        raise account_error(exc) from exc
    return Response(status_code=204)


@router.post("/password/forgot", status_code=204)
async def forgot_password(body: EmailBody, service: Service) -> Response:
    await service.forgot_password(body.email)
    return Response(status_code=204)


@router.post("/password/reset", response_model=SessionOut)
async def reset_password(body: PasswordResetBody, service: Service) -> SessionOut:
    try:
        return await service.reset_password(body.token, body.new_password)
    except AccountError as exc:
        raise account_error(exc) from exc


@router.get("/me", response_model=None)
async def me(user: CurrentUser) -> dict[str, str]:
    """Швидка перевірка сесії для шапки сайту: лише логін та ім'я."""
    return {"username": user.username, "first_name": user.first_name or ""}
