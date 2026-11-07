"""Акаунти й кабінет: вхідні дані й те, що бачить користувач. Без I/O."""

import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlencode

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, StringConstraints

from tickets_api.domain.alerts import AlertView, Email
from tickets_api.domain.flights import _StrictInput


def _normalize_login(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


Username = Annotated[
    str,
    BeforeValidator(_normalize_login),
    StringConstraints(pattern=r"^[a-z0-9_.]{3,30}$"),
]
"""Латиниця, цифри, _ і . — 3–30 символів; зберігаємо в нижньому регістрі."""
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]
SearchKind = Literal["flights", "stays", "trip"]


def _blank_to_none(value: str | None) -> str | None:
    return value or None


OptionalName = Annotated[Name | None, AfterValidator(_blank_to_none)]


class RegisterBody(_StrictInput):
    username: Username
    password: Password
    first_name: OptionalName = None
    last_name: OptionalName = None


class LoginBody(_StrictInput):
    login: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=254)]
    """Логін або підтверджений email."""
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class SessionOut(BaseModel):
    """Токен сесії — лише для веб-сервера (кладе його в httpOnly-cookie), не для браузера."""

    token: str
    expires_at: datetime


class ProfileBody(_StrictInput):
    first_name: OptionalName = None
    last_name: OptionalName = None


# Ключі фільтрів видачі в URL (apps/web/src/lib/search-params.ts) — і нічого іншого.
FLIGHT_FILTER_KEYS = frozenset(
    {
        "stops",
        "al",
        "xal",
        "dep",
        "deph",
        "arr",
        "arrh",
        "rdep",
        "rdeph",
        "rarr",
        "rarrh",
        "maxh",
        "maxlay",
        "minlay",
        "minself",
        "maxp",
        "maxt",
    }
)
_FILTER_VALUE = re.compile(r"^[A-Za-z0-9,\-]{1,100}$")


def clean_flight_filters(raw: str | None) -> str | None:
    """Лише відомі ключі з простими значеннями; порожньо — None. Решту фільтр розбере сам."""
    if not raw:
        return None
    kept = [
        (k, v)
        for k, v in parse_qsl(raw, keep_blank_values=False)
        if k in FLIGHT_FILTER_KEYS and _FILTER_VALUE.match(v)
    ]
    return urlencode(kept) or None


class FlightFiltersBody(_StrictInput):
    flight_filters: str | None = Field(default=None, max_length=1000)


class EmailBody(_StrictInput):
    email: Email


class PasswordChangeBody(_StrictInput):
    current_password: Annotated[str, StringConstraints(max_length=128)] | None = None
    """Обов'язковий, якщо пароль уже є (вхід лише через Google — встановлення без нього)."""
    new_password: Password


class TokenBody(_StrictInput):
    token: Annotated[str, StringConstraints(min_length=16, max_length=128)]


class PasswordResetBody(TokenBody):
    new_password: Password


class DeleteAccountBody(_StrictInput):
    confirm: Annotated[str, StringConstraints(max_length=128)]
    """Пароль (якщо є) або власний логін — щоб видалення не сталося випадково."""


class Account(BaseModel):
    id: str
    username: str
    first_name: str | None
    last_name: str | None
    email: str | None
    """Лише підтверджена адреса."""
    pending_email: str | None
    """Нова адреса, що чекає підтвердження з листа."""
    has_password: bool
    google_linked: bool
    telegram_linked: bool
    flight_filters: str | None = None
    """Збережені фільтри пошуку перельотів (рядок URL); веб додає їх до нового пошуку."""
    created_at: datetime


class SearchEntryBody(_StrictInput):
    kind: SearchKind
    params: Annotated[
        str, StringConstraints(min_length=1, max_length=500, pattern=r"^[\w%=&.,+:-]+$")
    ]
    """Рядок URL сторінки результатів (from=WAW&to=LIS&…)."""
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class SearchEntryRename(_StrictInput):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class SearchEntryOut(BaseModel):
    id: str
    kind: SearchKind
    params: str
    title: str
    saved: bool
    created_at: datetime
    updated_at: datetime


class AccountAlert(AlertView):
    manage_token: str
    """Власник бачить свої підписки й може відкрити сторінку керування."""


class GoogleStart(BaseModel):
    url: str
    state: str


class GoogleCallbackBody(_StrictInput):
    code: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    state: Annotated[str, StringConstraints(min_length=16, max_length=128)]


class GoogleStartBody(_StrictInput):
    mode: Literal["login", "link"] = "login"


class AuthStatus(BaseModel):
    google: bool
    """Чи налаштовано вхід через Google (є GOOGLE_CLIENT_ID/SECRET)."""
    email: Literal["live", "mock"]
