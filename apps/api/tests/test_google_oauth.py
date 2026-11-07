from collections.abc import AsyncIterator
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import respx
from tickets_api.auth.google import (
    TOKEN_ENDPOINT,
    USERINFO_ENDPOINT,
    GoogleAuthError,
    GoogleOAuth,
    new_pkce,
)

REDIRECT = "http://localhost:3000/api/auth/google/callback"


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as c:
        yield c


def test_authorization_url_uses_pkce_s256(client: httpx.AsyncClient) -> None:
    verifier, challenge = new_pkce()
    url = GoogleOAuth(client, "id.apps.googleusercontent.com", "s").authorization_url(
        state="st", challenge=challenge, redirect_uri=REDIRECT
    )

    query = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert query == {
        "client_id": "id.apps.googleusercontent.com",
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": "openid email profile",
        "state": "st",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    assert verifier != challenge
    assert 43 <= len(verifier) <= 128  # RFC 7636


@respx.mock
async def test_code_exchange_and_profile(client: httpx.AsyncClient) -> None:
    token = respx.post(TOKEN_ENDPOINT).mock(
        return_value=httpx.Response(200, json={"access_token": "at", "id_token": "x"})
    )
    respx.get(USERINFO_ENDPOINT).mock(
        return_value=httpx.Response(
            200,
            json={
                "sub": "1234",
                "email": "Max@Example.com",
                "email_verified": True,
                "given_name": "Макс",
                "family_name": "Д",
            },
        )
    )

    profile = await GoogleOAuth(client, "id", "secret").profile(
        code="c", verifier="v", redirect_uri=REDIRECT
    )

    assert (profile.sub, profile.email, profile.email_verified) == ("1234", "max@example.com", True)
    assert profile.given_name == "Макс"
    form = parse_qs(token.calls.last.request.content.decode())
    assert form["grant_type"] == ["authorization_code"]
    assert form["code_verifier"] == ["v"]
    assert form["redirect_uri"] == [REDIRECT]


@respx.mock
async def test_errors_do_not_leak_secret(client: httpx.AsyncClient) -> None:
    respx.post(TOKEN_ENDPOINT).mock(
        return_value=httpx.Response(400, json={"error": "invalid_grant"})
    )

    with pytest.raises(GoogleAuthError) as error:
        await GoogleOAuth(client, "id", "super-secret").profile(
            code="c", verifier="v", redirect_uri=REDIRECT
        )

    assert "invalid_grant" in str(error.value)
    assert "super-secret" not in str(error.value)
