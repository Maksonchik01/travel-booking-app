"""Поточний користувач з заголовка Authorization: Bearer <токен сесії>.

Токен знає лише веб-сервер (бере з httpOnly-cookie) — браузер напряму в API не ходить.
"""

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from tickets_api.db.models import User
from tickets_api.services.accounts import AccountService


def accounts(request: Request) -> AccountService:
    service: AccountService = request.app.state.accounts
    return service


def session_token(authorization: Annotated[str | None, Header()] = None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        return token if 16 <= len(token) <= 128 else None
    return None


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
