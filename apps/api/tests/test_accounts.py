"""Акаунти й кабінет проти Postgres (маркер integration): make test-integration або CI."""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from flight_fakes import FakeRedis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.auth.google import GoogleProfile
from tickets_api.db.models import AuthToken, SearchEntry, User, UserSession
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.accounts import RegisterBody, SearchEntryBody
from tickets_api.notifications.mail import MockMailer
from tickets_api.services.accounts import (
    AccountError,
    AccountService,
    AccountSettings,
    token_hash,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 11, 7, 12, tzinfo=UTC)
PREFIX = "ittest_"


class FakeGoogle:
    def __init__(self) -> None:
        self.profile_result = GoogleProfile("g-1", "it@example.com", True, "Іван", "Тест")

    def authorization_url(self, *, state: str, challenge: str, redirect_uri: str) -> str:
        return f"https://accounts.google.com/o/oauth2/v2/auth?state={state}"

    async def profile(self, *, code: str, verifier: str, redirect_uri: str) -> GoogleProfile:
        assert verifier
        assert redirect_uri.endswith("/api/auth/google/callback")
        return self.profile_result


class Env:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.now = NOW
        self.mailer = MockMailer()
        self.redis = FakeRedis()
        self.google = FakeGoogle()
        self.sessionmaker = sessionmaker
        self.service = AccountService(
            sessionmaker,
            redis=self.redis,  # type: ignore[arg-type]
            mailer=self.mailer,
            settings=AccountSettings(
                public_web_url="https://tickets.example", session_ttl_days=30, login_max_failures=5
            ),
            google=self.google,  # type: ignore[arg-type]
            clock=lambda: self.now,
        )

    async def register(self, name: str = "max", password: str = "password1", **kw: Any) -> Any:  # noqa: S107
        return await self.service.register(
            RegisterBody(username=PREFIX + name, password=password, **kw)
        )

    async def user(self, token: str) -> User:
        user = await self.service.user_for_session(token)
        assert user is not None
        return user

    def link(self) -> str:
        return self.mailer.sent[-1][2].split("token=")[1].split()[0]


async def _cleanup(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    async with sessionmaker() as session, session.begin():
        ids = (
            await session.scalars(
                select(User.id).where(
                    (User.username.like(f"{PREFIX}%")) | (User.google_sub.like("g-%"))
                )
            )
        ).all()
        for model in (SearchEntry, AuthToken, UserSession):
            await session.execute(delete(model).where(model.user_id.in_(ids)))
        await session.execute(delete(User).where(User.id.in_(ids)))


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    sessionmaker = create_sessionmaker(engine)
    await _cleanup(sessionmaker)
    yield Env(sessionmaker)
    await _cleanup(sessionmaker)
    await engine.dispose()


async def test_register_login_logout_and_unique_username(env: Env) -> None:
    session = await env.register(first_name="Макс")
    user = await env.user(session.token)
    assert (user.username, user.first_name) == ("ittest_max", "Макс")
    assert user.password_hash
    assert user.password_hash.startswith("scrypt$")
    with pytest.raises(AccountError, match="username_taken"):
        await env.register()

    second = await env.service.login(" ITTEST_MAX ", "password1")
    await env.service.logout(second.token)
    assert await env.service.user_for_session(second.token) is None
    assert await env.service.user_for_session(session.token) is not None
    # У БД — лише хеш токена.
    async with env.sessionmaker() as s:
        assert await s.get(UserSession, session.token) is None


async def test_bruteforce_pause_and_session_expiry(env: Env) -> None:
    session = await env.register()
    for _ in range(5):
        with pytest.raises(AccountError, match="invalid_credentials"):
            await env.service.login("ittest_max", "wrong")
    with pytest.raises(AccountError, match="too_many_attempts"):
        await env.service.login("ittest_max", "password1")

    env.now = NOW + timedelta(days=31)
    assert await env.service.user_for_session(session.token) is None


async def test_email_change_needs_link_then_login_by_email_and_reset(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)

    await env.service.request_email(user, "it@example.com")
    account = await env.service.account(await env.user(session.token))
    assert (account.email, account.pending_email) == (None, "it@example.com")

    await env.service.verify_email(env.link())
    assert (await env.user(session.token)).email == "it@example.com"
    with pytest.raises(AccountError, match="invalid_token"):
        await env.service.verify_email(env.link())  # одноразове

    other = await env.user((await env.register("other")).token)
    with pytest.raises(AccountError, match="email_taken"):
        await env.service.request_email(other, "it@example.com")

    await env.service.login("it@example.com", "password1")
    await env.service.forgot_password("nobody@example.com")  # мовчки: без розкриття адрес
    sent_before = len(env.mailer.sent)
    await env.service.forgot_password("it@example.com")
    assert len(env.mailer.sent) == sent_before + 1
    fresh = await env.service.reset_password(env.link(), "newpassword")
    assert await env.service.user_for_session(session.token) is None  # старі сесії завершено
    assert await env.service.user_for_session(fresh.token) is not None
    await env.service.login("ittest_max", "newpassword")


async def test_change_password_keeps_current_session_only(env: Env) -> None:
    keep = await env.register()
    other = await env.service.login("ittest_max", "password1")
    user = await env.user(keep.token)

    with pytest.raises(AccountError, match="wrong_password"):
        await env.service.change_password(user, "nope", "newpassword", keep.token)
    await env.service.change_password(user, "password1", "newpassword", keep.token)

    assert await env.service.user_for_session(keep.token) is not None
    assert await env.service.user_for_session(other.token) is None


async def test_google_login_creates_account_then_reuses_it(env: Env) -> None:
    start = await env.service.google_start("login", None)
    session, mode = await env.service.google_callback("code", start.state)

    assert mode == "login"
    assert session is not None
    user = await env.user(session.token)
    assert (user.email, user.first_name, user.google_sub) == ("it@example.com", "Іван", "g-1")
    assert user.password_hash is None
    assert user.username == "ituser"  # з email; закороткий логін доповнено
    with pytest.raises(AccountError, match="invalid_token"):
        await env.service.google_callback("code", start.state)  # state одноразовий

    again = await env.service.google_start("login", None)
    second, _ = await env.service.google_callback("code", again.state)
    assert second is not None
    assert (await env.user(second.token)).id == user.id
    # Без пароля Google не відв'язати — інакше не буде як увійти.
    with pytest.raises(AccountError, match="last_login_method"):
        await env.service.unlink_google(user)


async def test_google_links_to_existing_account_by_verified_email(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    await env.service.request_email(user, "it@example.com")
    await env.service.verify_email(env.link())

    start = await env.service.google_start("login", None)
    google_session, _ = await env.service.google_callback("code", start.state)

    assert google_session is not None
    assert (await env.user(google_session.token)).id == user.id
    # Непідтверджений email у Google — не прив'язуємо до чужого акаунта, а створюємо новий.
    env.google.profile_result = GoogleProfile("g-2", "it@example.com", False, None, None)
    other = await env.service.google_start("login", None)
    new_session, _ = await env.service.google_callback("code", other.state)
    assert new_session is not None
    assert (await env.user(new_session.token)).id != user.id


async def test_history_dedupes_saved_searches_and_delete_account(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    body = SearchEntryBody(kind="flights", params="from=WAW&to=LIS&depart=2026-12-05", title="A")

    await env.service.record_search(user, body)
    env.now = NOW + timedelta(minutes=5)
    await env.service.record_search(user, body.model_copy(update={"title": "B"}))
    history = await env.service.entries(user, saved=False)
    assert [(e.title, e.params) for e in history] == [("B", body.params)]

    saved = await env.service.save_search(user, body)
    assert (await env.service.save_search(user, body)).id == saved.id  # без дублів
    renamed = await env.service.rename_entry(user, saved.id, "Лісабон на Різдво")
    assert renamed.title == "Лісабон на Різдво"
    await env.service.clear_history(user)
    assert await env.service.entries(user, saved=False) == []
    assert len(await env.service.entries(user, saved=True)) == 1

    with pytest.raises(AccountError, match="wrong_password"):
        await env.service.delete_account(user, "nope")
    await env.service.delete_account(user, "password1")
    assert await env.service.user_for_session(session.token) is None
    async with env.sessionmaker() as s:
        left = await s.scalar(select(SearchEntry.id).where(SearchEntry.user_id == user.id))
    assert left is None


async def test_telegram_link_is_one_time_code_and_unlink(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    with pytest.raises(AccountError, match="telegram_unavailable"):
        await env.service.telegram_link_url(user)  # бот не налаштований
    service = AccountService(
        env.sessionmaker,
        redis=env.redis,  # type: ignore[arg-type]
        mailer=env.mailer,
        settings=AccountSettings(
            public_web_url="https://tickets.example",
            session_ttl_days=30,
            login_max_failures=5,
            bot_username="flyandbookbot",
        ),
        clock=lambda: env.now,
    )

    first = await service.telegram_link_url(user)
    url = await service.telegram_link_url(user)

    prefix = "https://t.me/flyandbookbot?start=link_"
    assert url.startswith(prefix)
    assert len(url.removeprefix("https://t.me/flyandbookbot?start=")) <= 64
    async with env.sessionmaker() as s:
        codes = (
            await s.scalars(select(AuthToken.token_hash).where(AuthToken.user_id == user.id))
        ).all()
        # Лише остання: попереднє посилання вже не діє, у БД — хеш коду.
        assert codes == [token_hash(url.removeprefix(prefix))]
        assert token_hash(first.removeprefix(prefix)) not in codes
        db_user = await s.get(User, user.id)
        assert db_user is not None
        db_user.telegram_chat_id = 4242
        await s.commit()

    assert (await service.account(await env.user(session.token))).telegram_linked
    await service.unlink_telegram(user)
    assert not (await service.account(await env.user(session.token))).telegram_linked
