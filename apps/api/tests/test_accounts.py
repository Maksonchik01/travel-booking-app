"""Акаунти й кабінет проти Postgres (маркер integration): make test-integration або CI."""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from flight_fakes import FakeRedis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.auth.google import GoogleProfile
from tickets_api.db.models import (
    AuthToken,
    ChatConversation,
    Favorite,
    SavedTrip,
    SearchEntry,
    User,
    UserAvatar,
    UserSession,
)
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.accounts import RegisterBody, SearchEntryBody
from tickets_api.domain.chats import ChatConversationBody
from tickets_api.domain.favorites import FavoriteBody
from tickets_api.domain.notify import NotifyPrefs
from tickets_api.domain.profile import PreferencesBody, SearchPrefs
from tickets_api.domain.saved_trips import SavedTripBody, SavedTripPatch
from tickets_api.domain.trips import TripExtra
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
        self.profile_result = GoogleProfile(
            "g-1", "it@example.com", True, "Іван", "Тест", "https://lh3.googleusercontent.com/a/1"
        )

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
        for model in (
            SearchEntry,
            Favorite,
            SavedTrip,
            ChatConversation,
            UserAvatar,
            AuthToken,
            UserSession,
        ):
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
    assert (
        await env.service.account(user)
    ).google_picture == "https://lh3.googleusercontent.com/a/1"
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


async def test_saved_flight_filters_keep_only_known_keys(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)

    saved = await env.service.save_flight_filters(
        user, "stops=1&dep=morning,afternoon&from=WAW&evil=<script>&maxp=200&maxt="
    )

    # Маршрут, дати й чужі ключі не зберігаємо — лише фільтри видачі.
    assert saved == "stops=1&dep=morning%2Cafternoon&maxp=200"
    account = await env.service.account(await env.user(session.token))
    assert account.flight_filters == saved
    assert await env.service.save_flight_filters(user, None) is None


def favorite(stay_id: str = "mock-lis-3", check_in: str = "2026-12-05") -> FavoriteBody:
    return FavoriteBody.model_validate(
        {
            "stay": {
                "source": "mock",
                "stay_id": stay_id,
                "name": "Hotel Riverside",
                "kind": "hotel",
                "city": "LIS",
                "rating": 8.4,
                "review_count": 120,
                "price_per_night": 95.5,
                "total_price": 286.5,
                "currency": "EUR",
                "check_in": check_in,
                "check_out": "2026-12-08",
                "price_at": "2026-11-07T10:00:00Z",
                "params": "city=LIS&in=2026-12-05&out=2026-12-08",
            }
        }
    )


async def test_favorites_dedupe_import_and_delete_with_account(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)

    first = await env.service.add_favorites(user, [favorite()])
    again = await env.service.add_favorites(user, [favorite(), favorite("mock-lis-4")])

    assert len(first) == 1
    assert len(again) == 2
    stays = [f.stay for f in [*again, *first]]
    assert all(s is not None for s in stays)
    assert {s.total_price for s in stays if s} == {
        first[0].stay.total_price if first[0].stay else 0
    }
    # ↑ знімок, не перерахунок: ціна та, що збережена
    # Ті самі об'єкт і дати — один запис; інші дати — окремий.
    other = await env.service.add_favorites(user, [favorite(check_in="2026-12-06")])
    assert len(other) == 3
    await env.service.delete_favorite(user, first[0].item_key)
    assert len(await env.service.favorites(user)) == 2

    await env.service.delete_account(user, "password1")
    async with env.sessionmaker() as s:
        left = await s.scalar(select(Favorite.id).where(Favorite.user_id == user.id))
    assert left is None


def saved_trip(title: str = "Лісабон на Різдво") -> SavedTripBody:
    return SavedTripBody.model_validate(
        {
            "title": title,
            "query": {
                "origin": "WAW",
                "destination": "LIS",
                "departure_date": "2026-12-05",
                "return_date": "2026-12-08",
                "flight": "mock:abc123",
                "stay": "mock:mock-lis-3",
            },
            "snapshot": {
                "money_total": 520,
                "confirmed": 520,
                "approximate": 0,
                "unknown": 0,
                "currency": "EUR",
                "check_in": "2026-12-05",
                "check_out": "2026-12-08",
                "nights": 3,
                "flight": {
                    "origin": "WAW",
                    "destination": "LIS",
                    "departure_at": "2026-12-05T06:10:00+01:00",
                    "arrival_at": "2026-12-05T09:30:00+00:00",
                    "return_departure_at": "2026-12-08T10:00:00+00:00",
                    "return_arrival_at": "2026-12-08T15:20:00+01:00",
                    "stops": 0,
                    "duration_min": 520,
                    "airlines": ["LO"],
                    "price": 230,
                    "price_status": "live",
                },
                "stay": {
                    "name": "Hotel Riverside",
                    "kind": "hotel",
                    "rating": 8.4,
                    "review_count": 120,
                    "district": "Центр",
                    "distance_to_center_km": 1.2,
                    "cancellation": "free",
                    "total_price": 290,
                },
                "priced_at": "2026-11-07T10:00:00Z",
            },
        }
    )


async def test_saved_trips_copy_edit_rename_delete(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)

    [first] = await env.service.save_trips(user, [saved_trip()])
    [copy] = await env.service.save_trips(user, [saved_trip("Лісабон (копія)")])
    assert first.query.flight == "mock:abc123"
    assert first.snapshot.money_total == 520  # знімок — як збережено, без перерахунку
    assert copy.id != first.id

    env.now = NOW + timedelta(minutes=5)
    edited = saved_trip().model_copy(
        update={"query": first.query.model_copy(update={"stay": "mock:mock-lis-5"})}
    )
    updated = await env.service.update_trip(user, first.id, edited)
    assert updated.query.stay == "mock:mock-lis-5"
    env.now = NOW + timedelta(minutes=10)
    renamed = await env.service.patch_trip(user, copy.id, SavedTripPatch(title="Інший варіант"))
    assert renamed.title == "Інший варіант"
    assert renamed.status == "draft"  # за замовчуванням — чернетка
    planned = await env.service.patch_trip(user, copy.id, SavedTripPatch(status="planned"))
    assert (planned.title, planned.status) == ("Інший варіант", "planned")
    kept = await env.service.update_trip(user, copy.id, saved_trip("Інший варіант"))
    assert kept.status == "planned"  # «Зберегти зміни» не скидає статус
    trips = await env.service.saved_trips(user)
    assert [t.id for t in trips] == [copy.id, first.id]  # останні зміни — першими

    await env.service.delete_trip(user, first.id)
    with pytest.raises(AccountError, match="not_found"):
        await env.service.update_trip(user, first.id, edited)
    assert len(await env.service.saved_trips(user)) == 1

    await env.service.delete_account(user, "password1")
    async with env.sessionmaker() as s:
        left = await s.scalar(select(SavedTrip.id).where(SavedTrip.user_id == user.id))
    assert left is None


def chat(updated_at: int, text: str = "Хочу в Лісабон") -> ChatConversationBody:
    return ChatConversationBody(
        mode="trip",
        title="Лісабон",
        created_at=1,
        updated_at=updated_at,
        turns=[{"role": "user", "text": text}],
    )


async def test_chat_sync_only_with_consent_newer_wins_and_withdrawal_deletes(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)

    assert (await env.service.chats(user)).enabled is False
    with pytest.raises(AccountError, match="not_found"):
        await env.service.save_chat(user, "conv-0001", chat(1000))  # без згоди — нічого

    await env.service.set_chat_sync(user, True)
    user = await env.user(session.token)
    await env.service.save_chat(user, "conv-0001", chat(2000, "нова"))
    stale = await env.service.save_chat(user, "conv-0001", chat(1500, "стара"))
    assert stale.turns[0].text == "нова"  # старіша копія з іншого пристрою не перезаписує
    state = await env.service.chats(user)
    assert [c.id for c in state.conversations] == ["conv-0001"]

    await env.service.delete_chat(user, "conv-0001")
    await env.service.save_chat(user, "conv-0002", chat(3000))
    off = await env.service.set_chat_sync(user, False)  # відкликання згоди
    assert off.enabled is False
    async with env.sessionmaker() as s:
        left = await s.scalar(
            select(ChatConversation.id).where(ChatConversation.user_id == user.id)
        )
    assert left is None

    await env.service.set_chat_sync(user, True)
    user = await env.user(session.token)
    await env.service.save_chat(user, "conv-0003", chat(4000))
    await env.service.delete_account(user, "password1")
    async with env.sessionmaker() as s:
        left = await s.scalar(
            select(ChatConversation.id).where(ChatConversation.user_id == user.id)
        )
    assert left is None


async def test_favorites_three_kinds_keep_params_and_price_time(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    flight = FavoriteBody.model_validate(
        {
            "kind": "flight",
            "flight": {
                "source": "mock",
                "offer_id": "abc123",
                "origin": "WAW",
                "destination": "LIS",
                "departure_at": "2026-12-05T06:10:00+01:00",
                "return_departure_at": "2026-12-08T10:00:00+00:00",
                "stops": 0,
                "airlines": ["LO"],
                "passengers": 2,
                "price": 230,
                "currency": "EUR",
                "price_status": "cached",
                "price_at": "2026-11-07T10:00:00Z",
                "params": "from=WAW&to=LIS&depart=2026-12-05",
            },
        }
    )
    trip = FavoriteBody.model_validate(
        {
            "kind": "trip",
            "trip": {
                "title": "Лісабон",
                "query": saved_trip().query.model_dump(mode="json"),
                "snapshot": saved_trip().snapshot.model_dump(mode="json"),
            },
        }
    )

    items = await env.service.add_favorites(user, [favorite(), flight, trip])

    kinds = {f.kind: f for f in items}
    assert set(kinds) == {"stay", "flight", "trip"}
    assert kinds["flight"].item_key == "mock:abc123"
    assert kinds["flight"].flight is not None
    assert kinds["flight"].flight.params.startswith("from=WAW")
    assert kinds["trip"].trip is not None
    assert kinds["trip"].trip.query.flight == "mock:abc123"
    stay = favorite().stay
    assert stay is not None
    with pytest.raises(ValueError, match="категорії"):
        FavoriteBody.model_validate({"kind": "flight", "stay": stay.model_dump()})


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def test_preferences_validate_airports_and_dedupe_home(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    account = await env.service.account(user)
    assert (account.locale, account.favorite_airports, account.avatar_version) == (None, [], None)

    body = PreferencesBody(
        locale="ru",
        currency="PLN",
        country="pl",
        home_airport="waw",
        favorite_airports=["KRK", "WAW", "LON", "KRK"],
    )
    await env.service.update_preferences(user, body)
    account = await env.service.account(await env.user(session.token))
    assert (account.locale, account.currency, account.country) == ("ru", "PLN", "PL")
    assert account.home_airport == "WAW"
    assert account.favorite_airports == ["KRK", "LON"]  # без дублів і без домашнього

    with pytest.raises(AccountError, match="unknown_place"):
        await env.service.update_preferences(user, PreferencesBody(home_airport="QQQ"))
    await env.service.set_locale(user, "en")
    assert (await env.service.account(await env.user(session.token))).locale == "en"


async def test_search_prefs_roundtrip_and_reset(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    prefs = SearchPrefs.model_validate(
        {
            "flights": {"cabin": "business", "max_stops": 1, "airlines": ["lo", "LO", "LH"]},
            "stays": {"kinds": ["hotel"], "min_rating": 8, "free_cancellation": True},
        }
    )
    await env.service.save_search_prefs(user, prefs)
    saved = (await env.service.account(await env.user(session.token))).search_prefs
    assert saved.flights.airlines == ["LO", "LH"]
    assert (saved.flights.cabin, saved.stays.min_rating) == ("business", 8)

    await env.service.save_search_prefs(user, SearchPrefs())
    async with env.sessionmaker() as db:
        assert await db.scalar(select(User.search_prefs).where(User.id == user.id)) is None


async def test_avatar_checks_signature_size_and_goes_with_account(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    with pytest.raises(AccountError, match="invalid_image"):
        await env.service.set_avatar(user, b"<svg onload=alert(1)>")
    with pytest.raises(AccountError, match="image_too_large"):
        await env.service.set_avatar(user, PNG + b"\x00" * 300 * 1024)

    await env.service.set_avatar(user, PNG)
    assert await env.service.avatar(user.id) == ("image/png", PNG)
    first = (await env.service.account(user)).avatar_version
    env.now += timedelta(minutes=1)
    await env.service.set_avatar(user, b"\xff\xd8\xff" + b"\x00" * 8)
    assert (await env.service.account(user)).avatar_version != first
    await env.service.delete_avatar(user)
    assert await env.service.avatar(user.id) is None

    await env.service.set_avatar(user, PNG)
    await env.service.delete_account(user, "password1")
    async with env.sessionmaker() as db:
        assert await db.get(UserAvatar, user.id) is None


async def test_sessions_list_devices_end_one_and_others(env: Env) -> None:
    first = await env.service.register(
        RegisterBody(username=PREFIX + "max", password="password1"),  # noqa: S106
        "Chrome · macOS",
    )
    user = await env.user(first.token)
    env.now += timedelta(minutes=1)
    second = await env.service.login(PREFIX + "max", "password1", "Safari · iOS")
    env.now += timedelta(minutes=1)
    third = await env.service.login(PREFIX + "max", "password1")

    listed = await env.service.sessions(user, second.token)
    assert [s.current for s in listed] == [True, False, False]
    assert {s.device for s in listed} == {"Chrome · macOS", "Safari · iOS", None}
    assert all(len(s.id) == 16 for s in listed)

    # Остання активність оновлюється не частіше, ніж раз на 15 хв.
    env.now += timedelta(minutes=20)
    await env.user(first.token)
    listed = await env.service.sessions(user, second.token)
    assert listed[1].device == "Chrome · macOS"

    await env.service.end_session(user, listed[1].id)
    assert await env.service.user_for_session(first.token) is None
    with pytest.raises(AccountError, match="not_found"):
        await env.service.end_session(user, listed[1].id)
    with pytest.raises(AccountError, match="not_found"):
        await env.service.end_session(user, "short")

    assert await env.service.end_other_sessions(user, second.token) == 1
    assert await env.service.user_for_session(third.token) is None
    assert await env.service.user_for_session(second.token) is not None


async def test_notify_prefs_saved_and_chats_cleared(env: Env) -> None:
    session = await env.register()
    user = await env.user(session.token)
    await env.service.save_notify_prefs(
        user, NotifyPrefs(email=False, quiet_start=22, quiet_end=8, timezone="Europe/Kyiv")
    )
    prefs = (await env.service.account(await env.user(session.token))).notify_prefs
    assert (prefs.email, prefs.quiet_start, prefs.timezone) == (False, 22, "Europe/Kyiv")
    await env.service.save_notify_prefs(user, NotifyPrefs())
    async with env.sessionmaker() as db:
        assert await db.scalar(select(User.notify_prefs).where(User.id == user.id)) is None

    await env.service.set_chat_sync(user, True)
    await env.service.save_chat(user, "conv-0009", chat(1000))
    await env.service.clear_chats(user)
    state = await env.service.chats(user)
    assert (state.enabled, state.conversations) == (True, [])


async def test_public_trip_link_is_off_by_default_and_shows_nothing_personal(env: Env) -> None:
    """Модуль 20.2: приватна за замовчуванням; посилання вмикає й вимикає лише власник."""
    user = await env.user((await env.register()).token)
    body = saved_trip("Іван — медовий місяць")
    query = body.query.model_copy(
        update={
            "budget_total": 1500,
            "extras": [TripExtra(label="Подарунок для Олі", amount=Decimal(40))],
        }
    )
    body = body.model_copy(update={"query": query})
    [trip] = await env.service.save_trips(user, [body])
    assert trip.share_token is None

    other = await env.user((await env.register("other")).token)
    with pytest.raises(AccountError, match="not_found"):
        await env.service.share_trip(other, trip.id, enabled=True)

    shared = await env.service.share_trip(user, trip.id, enabled=True)
    assert shared.share_token is not None
    assert len(shared.share_token) >= 20
    again = await env.service.share_trip(user, trip.id, enabled=True)
    assert again.share_token == shared.share_token  # посилання стабільне, поки ввімкнене

    public = await env.service.shared_trip(shared.share_token)
    assert public is not None
    dumped = public.model_dump_json()
    for personal in ("Іван", "Олі", "1500", user.id, user.username):
        assert personal not in dumped
    assert public.query.flight == "mock:abc123"
    assert public.snapshot.money_total == Decimal(520)

    await env.service.share_trip(user, trip.id, enabled=False)
    assert await env.service.shared_trip(shared.share_token) is None
