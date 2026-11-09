"""Вхід через Google: OAuth 2.0 authorization code + PKCE (S256).

Ендпоінти — з https://accounts.google.com/.well-known/openid-configuration:
authorization_endpoint, token_endpoint, userinfo_endpoint. Профіль беремо з userinfo
(sub, email, email_verified, given_name, family_name) за access_token — без розбору JWT.
Секрет клієнта й коди в логи не потрапляють.
"""

import base64
import hashlib
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit

import httpx

AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"  # noqa: S105 — адреса, не секрет
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
SCOPE = "openid email profile"


class GoogleAuthError(Exception):
    pass


@dataclass(frozen=True)
class GoogleProfile:
    sub: str
    email: str | None
    email_verified: bool
    given_name: str | None
    family_name: str | None
    picture: str | None = None
    """Фото профілю Google (https://…googleusercontent.com/…) — за замовчуванням в аватарі."""


def new_pkce() -> tuple[str, str]:
    """(code_verifier, code_challenge) — RFC 7636, метод S256."""
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge.rstrip(b"=").decode()


class GoogleOAuth:
    def __init__(self, http: httpx.AsyncClient, client_id: str, client_secret: str) -> None:
        self._http = http
        self._client_id = client_id
        self._client_secret = client_secret

    def authorization_url(self, *, state: str, challenge: str, redirect_uri: str) -> str:
        params = {
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
        return f"{AUTHORIZATION_ENDPOINT}?{urlencode(params)}"

    async def profile(self, *, code: str, verifier: str, redirect_uri: str) -> GoogleProfile:
        try:
            token = await self._http.post(
                TOKEN_ENDPOINT,
                data={
                    "code": code,
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": verifier,
                },
                timeout=15,
            )
            body = token.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GoogleAuthError(f"token: {type(exc).__name__}") from exc
        access = body.get("access_token") if isinstance(body, dict) else None
        if token.status_code != 200 or not isinstance(access, str):
            error = body.get("error") if isinstance(body, dict) else None
            raise GoogleAuthError(f"token: HTTP {token.status_code} {error or ''}".strip())
        try:
            info = await self._http.get(
                USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {access}"}, timeout=15
            )
            data = info.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GoogleAuthError(f"userinfo: {type(exc).__name__}") from exc
        if info.status_code != 200 or not isinstance(data, dict) or not data.get("sub"):
            raise GoogleAuthError(f"userinfo: HTTP {info.status_code}")
        email = data.get("email")
        return GoogleProfile(
            sub=str(data["sub"]),
            email=email.lower() if isinstance(email, str) else None,
            email_verified=data.get("email_verified") is True,
            given_name=_text(data.get("given_name")),
            family_name=_text(data.get("family_name")),
            picture=_picture(data.get("picture")),
        )


def _text(value: object) -> str | None:
    return value.strip()[:60] or None if isinstance(value, str) else None


def _picture(value: object) -> str | None:
    """Лише https-адреси Google (інші хости в <img> не підставляємо)."""
    if not isinstance(value, str) or len(value) > 500:
        return None
    url = urlsplit(value)
    host = url.hostname or ""
    google = host == "googleusercontent.com" or host.endswith(".googleusercontent.com")
    return value if url.scheme == "https" and google else None
