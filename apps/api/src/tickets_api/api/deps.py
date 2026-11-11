"""Поточний користувач з заголовка Authorization: Bearer <токен сесії>.

Токен знає лише веб-сервер (бере з httpOnly-cookie) — браузер напряму в API не ходить.
"""

import time
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from tickets_api.db.models import User
from tickets_api.providers.budget import ApiMeter
from tickets_api.services.accounts import AccountService


def accounts(request: Request) -> AccountService:
    service: AccountService = request.app.state.accounts
    return service


def session_token(authorization: Annotated[str | None, Header()] = None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        return token if 16 <= len(token) <= 128 else None
    return None


def client_device(x_client_device: Annotated[str | None, Header()] = None) -> str | None:
    """Пристрій сесії («Chrome · macOS») від вебу — лише для впізнавання в списку сесій.

    Не секрет і не доказ: беремо друковані символи, до 60.
    """
    if not x_client_device:
        return None
    cleaned = "".join(ch for ch in x_client_device if ch.isprintable()).strip()[:60]
    return cleaned or None


async def optional_user(
    service: Annotated[AccountService, Depends(accounts)],
    token: Annotated[str | None, Depends(session_token)],
) -> User | None:
    return await service.user_for_session(token) if token else None


async def current_user(user: Annotated[User | None, Depends(optional_user)]) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="not_authenticated")
    return user


Service = Annotated[AccountService, Depends(accounts)]
CurrentUser = Annotated[User, Depends(current_user)]
OptionalUser = Annotated[User | None, Depends(optional_user)]
Token = Annotated[str | None, Depends(session_token)]
Device = Annotated[str | None, Depends(client_device)]


async def note_search(request: Request, kind: str, *, ok: bool, started: float) -> None:
    """Пошук для собівартості й моніторингу (ADR 0055, 0062): лічильник і час, без параметрів."""
    meter: ApiMeter | None = getattr(request.app.state, "meter", None)
    if meter is not None:
        await meter.note_search(kind, ok=ok, ms=int((time.monotonic() - started) * 1000))
