"""Акаунти й кабінет (ADR 0011): реєстрація, вхід (логін/пароль, Google), сесії, профіль,
пошта з підтвердженням, пароль, історія й збережені пошуки, видалення акаунта.

Безпека:
- паролі — scrypt; токени сесій і листів — у БД лише SHA-256;
- захист від підбору: після LOGIN_MAX_FAILURES невдалих спроб за 15 хв — пауза;
- email лише підтверджений (лист із одноразовим посиланням); «забули пароль» завжди
  відповідає однаково — не видає, чи є така адреса;
- Google: state + PKCE у Redis (10 хв), прив'язка за підтвердженим email лише до акаунта з
  тією ж ПІДТВЕРДЖЕНОЮ адресою.
"""

import contextlib
import hashlib
import json
import re
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.auth.google import GoogleAuthError, GoogleOAuth, GoogleProfile, new_pkce
from tickets_api.auth.passwords import hash_password, verify_password
from tickets_api.db.models import (
    Alert,
    AuthToken,
    ChatConversation,
    Favorite,
    SavedTrip,
    SearchEntry,
    User,
    UserAvatar,
    UserSession,
)
from tickets_api.domain.accounts import (
    Account,
    AccountAlert,
    GoogleStart,
    RegisterBody,
    SearchEntryBody,
    SearchEntryOut,
    SessionInfo,
    SessionOut,
    clean_flight_filters,
)
from tickets_api.domain.chats import (
    MAX_SYNCED_CONVERSATIONS,
    ChatConversationBody,
    ChatConversationOut,
    ChatSyncState,
    conversation_out,
)
from tickets_api.domain.favorites import (
    MAX_FAVORITES,
    FavoriteBody,
    FavoriteFlight,
    FavoriteOut,
    FavoriteStay,
    FavoriteTrip,
)
from tickets_api.domain.locale import UiLocale
from tickets_api.domain.notify import NotifyPrefs, notify_prefs
from tickets_api.domain.profile import PreferencesBody, SearchPrefs
from tickets_api.domain.saved_trips import (
    MAX_SAVED_TRIPS,
    SavedTripBody,
    SavedTripOut,
    SavedTripPatch,
    TripSnapshot,
)
from tickets_api.domain.trips import TripQuery
from tickets_api.notifications.mail import Mailer, MailError
from tickets_api.reference.airports import default_airport_directory

log = structlog.get_logger(__name__)

FAILURE_WINDOW_S = 15 * 60
OAUTH_STATE_TTL_S = 10 * 60
EMAIL_TOKEN_TTL = timedelta(hours=24)
RESET_TOKEN_TTL = timedelta(hours=1)
TELEGRAM_LINK_TTL = timedelta(minutes=30)
MAX_HISTORY = 200
MAX_SAVED = 100

Clock = Callable[[], datetime]
AccountErrorCode = Literal[
    "username_taken",
    "invalid_credentials",
    "too_many_attempts",
    "email_taken",
    "invalid_token",
    "wrong_password",
    "last_login_method",
    "google_unavailable",
    "google_failed",
    "google_taken",
    "limit_reached",
    "not_found",
    "telegram_unavailable",
    "unknown_place",
    "invalid_image",
    "image_too_large",
]


SEEN_EVERY = timedelta(minutes=15)
SESSION_ID_LENGTH = 16
MAX_AVATAR_BYTES = 300 * 1024
"""Веб зменшує фото до 256×256 перед завантаженням — цього з запасом досить."""


def image_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def locale_or_none(value: str | None) -> UiLocale | None:
    return value if value in ("en", "uk", "ru") else None  # type: ignore[return-value]


def _search_prefs(raw: str | None) -> SearchPrefs:
    """Збережене колись іншою версією й тепер невалідне — просто «не задано»."""
    if not raw:
        return SearchPrefs()
    try:
        return SearchPrefs.model_validate_json(raw)
    except ValueError:
        return SearchPrefs()


class AccountError(Exception):
    """Очікувана помилка з кодом — API перетворює її на 4xx з цим кодом."""

    def __init__(self, code: AccountErrorCode) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AccountSettings:
    public_web_url: str
    session_ttl_days: int
    login_max_failures: int
    bot_username: str | None = None


def token_hash(token: str) -> str:
    """SHA-256 токена: у БД — лише він (сесії, листи, прив'язка Telegram)."""
    return hashlib.sha256(token.encode()).hexdigest()


_hash = token_hash


class AccountService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        redis: Redis,
        mailer: Mailer,
        settings: AccountSettings,
        google: GoogleOAuth | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._redis = redis
        self._mailer = mailer
        self._settings = settings
        self._google = google
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def google_enabled(self) -> bool:
        return self._google is not None

    @property
    def mail_mode(self) -> Literal["live", "mock"]:
        return "mock" if self._mailer.name == "mock" else "live"

    # --- реєстрація й вхід ------------------------------------------------------------

    async def register(self, body: RegisterBody, device: str | None = None) -> SessionOut:
        user = User(
            id=uuid.uuid4().hex,
            username=body.username,
            password_hash=await hash_password(body.password),
            first_name=body.first_name,
            last_name=body.last_name,
        )
        try:
            async with self._sessionmaker() as session, session.begin():
                session.add(user)
        except IntegrityError as exc:
            raise AccountError("username_taken") from exc
        return await self._new_session(user.id, device)

    async def login(self, login: str, password: str, device: str | None = None) -> SessionOut:
        key = f"auth:fail:{login.strip().lower()}"
        if await self._failures(key) >= self._settings.login_max_failures:
            raise AccountError("too_many_attempts")
        identifier = login.strip().lower()
        async with self._sessionmaker() as session:
            user = await session.scalar(
                select(User).where(or_(User.username == identifier, User.email == identifier))
            )
        # Перевіряємо хеш і для неіснуючого логіна — однаковий час відповіді.
        ok = await verify_password(password, user.password_hash if user else None)
        if user is None or not ok:
            await self._fail(key)
            raise AccountError("invalid_credentials")
        await self._clear(key)
        return await self._new_session(user.id, device)

    async def user_for_session(self, token: str) -> User | None:
        now = self._clock()
        async with self._sessionmaker() as session:
            row = await session.get(UserSession, _hash(token))
            if row is None or _aware(row.expires_at) <= now:
                return None
            # Остання активність для списку сесій — без запису на кожен запит.
            if row.last_seen_at is None or now - _aware(row.last_seen_at) >= SEEN_EVERY:
                row.last_seen_at = now
                await session.commit()
            return await session.get(User, row.user_id)

    async def user_by_id(self, user_id: str) -> User:
        async with self._sessionmaker() as session:
            user = await session.get(User, user_id)
        if user is None:
            raise AccountError("not_found")
        return user

    async def logout(self, token: str, *, everywhere: bool = False) -> None:
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(UserSession, _hash(token))
            if row is None:
                return
            if everywhere:
                await session.execute(delete(UserSession).where(UserSession.user_id == row.user_id))
            else:
                await session.delete(row)

    # --- Google -----------------------------------------------------------------------

    async def google_start(
        self, mode: Literal["login", "link"], user_id: str | None
    ) -> GoogleStart:
        if self._google is None:
            raise AccountError("google_unavailable")
        state = secrets.token_urlsafe(24)
        verifier, challenge = new_pkce()
        payload = json.dumps({"verifier": verifier, "mode": mode, "user_id": user_id})
        try:
            await self._redis.set(f"auth:oauth:{state}", payload, ex=OAUTH_STATE_TTL_S)
        except RedisError as exc:
            raise AccountError("google_unavailable") from exc
        url = self._google.authorization_url(
            state=state, challenge=challenge, redirect_uri=self._google_redirect()
        )
        return GoogleStart(url=url, state=state)

    async def google_callback(
        self, code: str, state: str, device: str | None = None
    ) -> tuple[SessionOut | None, str]:
        """(нова сесія або None — якщо це прив'язка до вже відкритої сесії, режим)."""
        if self._google is None:
            raise AccountError("google_unavailable")
        try:
            raw = await self._redis.getdel(f"auth:oauth:{state}")
        except RedisError as exc:
            raise AccountError("google_failed") from exc
        if not raw:
            raise AccountError("invalid_token")
        saved = json.loads(raw)
        try:
            profile = await self._google.profile(
                code=code, verifier=saved["verifier"], redirect_uri=self._google_redirect()
            )
        except GoogleAuthError as exc:
            log.warning("auth.google_failed", error=str(exc))
            raise AccountError("google_failed") from exc
        if saved["mode"] == "link" and saved.get("user_id"):
            await self._link_google(saved["user_id"], profile)
            return None, "link"
        user_id = await self._google_user(profile)
        return await self._new_session(user_id, device), "login"

    async def _link_google(self, user_id: str, profile: GoogleProfile) -> None:
        async with self._sessionmaker() as session, session.begin():
            owner = await session.scalar(select(User).where(User.google_sub == profile.sub))
            if owner is not None and owner.id != user_id:
                raise AccountError("google_taken")
            user = await session.get(User, user_id)
            if user is None:
                raise AccountError("not_found")
            user.google_sub = profile.sub
            user.google_picture = profile.picture
            if user.email is None and profile.email and profile.email_verified:
                taken = await session.scalar(select(User.id).where(User.email == profile.email))
                if taken is None:
                    user.email = profile.email

    async def _google_user(self, profile: GoogleProfile) -> str:
        async with self._sessionmaker() as session, session.begin():
            user = await session.scalar(select(User).where(User.google_sub == profile.sub))
            if user is not None:
                user.google_picture = profile.picture
                return user.id
            # Той самий ПІДТВЕРДЖЕНИЙ email (і в Google, і в нас) — це той самий власник.
            if profile.email and profile.email_verified:
                user = await session.scalar(select(User).where(User.email == profile.email))
                if user is not None:
                    user.google_sub = profile.sub
                    user.google_picture = profile.picture
                    return user.id
            user = User(
                id=uuid.uuid4().hex,
                username=await _free_username(session, profile),
                first_name=profile.given_name,
                last_name=profile.family_name,
                email=profile.email if profile.email and profile.email_verified else None,
                google_sub=profile.sub,
                google_picture=profile.picture,
            )
            session.add(user)
            return user.id

    async def telegram_link_url(self, user: User) -> str:
        """Посилання t.me/<бот>?start=link_<код>: бот прив'яже свій чат до цього акаунта."""
        if not self._settings.bot_username:
            raise AccountError("telegram_unavailable")
        token = secrets.token_urlsafe(24)  # link_ + 32 символи ≤ 64 (ліміт deep link)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(AuthToken).where(
                    AuthToken.user_id == user.id, AuthToken.purpose == "telegram_link"
                )
            )
            session.add(
                AuthToken(
                    token_hash=_hash(token),
                    user_id=user.id,
                    purpose="telegram_link",
                    expires_at=self._clock() + TELEGRAM_LINK_TTL,
                )
            )
        return f"https://t.me/{self._settings.bot_username}?start=link_{token}"

    async def unlink_telegram(self, user: User) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(telegram_chat_id=None)
            )

    async def unlink_google(self, user: User) -> None:
        if user.password_hash is None:
            raise AccountError("last_login_method")
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(google_sub=None, google_picture=None)
            )

    def _google_redirect(self) -> str:
        return f"{self._settings.public_web_url}/api/auth/google/callback"

    # --- кабінет: профіль, пошта, пароль ----------------------------------------------

    async def account(self, user: User) -> Account:
        async with self._sessionmaker() as session:
            pending = await session.scalar(
                select(AuthToken.email)
                .where(
                    AuthToken.user_id == user.id,
                    AuthToken.purpose == "verify_email",
                    AuthToken.used_at.is_(None),
                    AuthToken.expires_at > self._clock(),
                )
                .order_by(AuthToken.expires_at.desc())
                .limit(1)
            )
        return Account(
            id=user.id,
            username=user.username,
            first_name=user.first_name,
            last_name=user.last_name,
            email=user.email,
            pending_email=pending,
            has_password=user.password_hash is not None,
            google_linked=user.google_sub is not None,
            telegram_linked=user.telegram_chat_id is not None,
            flight_filters=user.flight_filters,
            chat_sync=user.chat_sync,
            locale=locale_or_none(user.locale),
            currency=user.currency,
            country=user.country,
            home_airport=user.home_airport,
            favorite_airports=user.favorite_airports.split(",") if user.favorite_airports else [],
            search_prefs=_search_prefs(user.search_prefs),
            notify_prefs=notify_prefs(user.notify_prefs),
            google_picture=user.google_picture,
            avatar_version=await self.avatar_version(user.id),
            created_at=user.created_at,
        )

    async def save_flight_filters(self, user: User, raw: str | None) -> str | None:
        """Зберігає лише відомі ключі фільтрів; None — забути збережене."""
        cleaned = clean_flight_filters(raw)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(flight_filters=cleaned)
            )
        return cleaned

    async def update_profile(self, user: User, first: str | None, last: str | None) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(first_name=first, last_name=last)
            )

    async def update_preferences(self, user: User, body: PreferencesBody) -> None:
        """Аеропорти — лише відомі довіднику коди (аеропорт або місто)."""
        directory = default_airport_directory()
        codes = [c for c in (body.home_airport, *body.favorite_airports) if c]
        if any(not directory.knows(code) for code in codes):
            raise AccountError("unknown_place")
        favorites = [c for c in body.favorite_airports if c != body.home_airport]
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User)
                .where(User.id == user.id)
                .values(
                    locale=body.locale,
                    currency=body.currency,
                    country=body.country,
                    home_airport=body.home_airport,
                    favorite_airports=",".join(favorites) or None,
                )
            )

    async def set_locale(self, user: User, locale: UiLocale) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(update(User).where(User.id == user.id).values(locale=locale))

    async def save_search_prefs(self, user: User, prefs: SearchPrefs) -> None:
        stored = None if prefs == SearchPrefs() else prefs.model_dump_json(exclude_defaults=True)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(search_prefs=stored)
            )

    async def save_notify_prefs(self, user: User, prefs: NotifyPrefs) -> None:
        stored = None if prefs == NotifyPrefs() else prefs.model_dump_json(exclude_defaults=True)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(notify_prefs=stored)
            )

    # --- сесії (модуль 10c) -----------------------------------------------------------

    async def sessions(self, user: User, current: str | None) -> list[SessionInfo]:
        """Активні сесії, найсвіжіші першими; `id` — початок хешу (сам токен не розкриваємо)."""
        current_hash = _hash(current) if current else None
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(UserSession)
                    .where(UserSession.user_id == user.id, UserSession.expires_at > self._clock())
                    .order_by(UserSession.created_at.desc())
                )
            ).all()
        infos = [
            SessionInfo(
                id=row.token_hash[:SESSION_ID_LENGTH],
                device=row.device,
                created_at=row.created_at,
                last_seen_at=row.last_seen_at,
                expires_at=row.expires_at,
                current=row.token_hash == current_hash,
            )
            for row in rows
        ]
        return sorted(
            infos, key=lambda i: (not i.current, -(i.last_seen_at or i.created_at).timestamp())
        )

    async def end_session(self, user: User, session_id: str) -> None:
        """Завершити одну сесію власника (поточну теж — це вихід)."""
        if len(session_id) != SESSION_ID_LENGTH:
            raise AccountError("not_found")
        async with self._sessionmaker() as session, session.begin():
            result = await session.execute(
                delete(UserSession).where(
                    UserSession.user_id == user.id,
                    UserSession.token_hash.startswith(session_id, autoescape=True),
                )
            )
        if not getattr(result, "rowcount", 0):
            raise AccountError("not_found")

    async def end_other_sessions(self, user: User, keep: str) -> int:
        async with self._sessionmaker() as session, session.begin():
            result = await session.execute(
                delete(UserSession).where(
                    UserSession.user_id == user.id, UserSession.token_hash != _hash(keep)
                )
            )
        return int(getattr(result, "rowcount", 0) or 0)

    async def clear_chats(self, user: User) -> None:
        """Очистити розмови на сервері; згода на синхронізацію лишається як була."""
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(ChatConversation).where(ChatConversation.user_id == user.id)
            )

    async def avatar_version(self, user_id: str) -> int | None:
        async with self._sessionmaker() as session:
            at = await session.scalar(
                select(UserAvatar.updated_at).where(UserAvatar.user_id == user_id)
            )
        return int(at.timestamp()) if at else None

    async def avatar(self, user_id: str) -> tuple[str, bytes] | None:
        async with self._sessionmaker() as session:
            row = await session.get(UserAvatar, user_id)
        return (row.content_type, row.data) if row else None

    async def set_avatar(self, user: User, data: bytes) -> None:
        """Власне фото: PNG, JPEG чи WebP (за сигнатурою, а не за заголовком) до 300 КБ."""
        if len(data) > MAX_AVATAR_BYTES:
            raise AccountError("image_too_large")
        content_type = image_type(data)
        if content_type is None:
            raise AccountError("invalid_image")
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(UserAvatar, user.id)
            if row is None:
                session.add(
                    UserAvatar(
                        user_id=user.id,
                        content_type=content_type,
                        data=data,
                        updated_at=self._clock(),
                    )
                )
            else:
                row.content_type = content_type
                row.data = data
                row.updated_at = self._clock()

    async def delete_avatar(self, user: User) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(delete(UserAvatar).where(UserAvatar.user_id == user.id))

    async def request_email(self, user: User, email: str) -> None:
        """Нова адреса стане основною лише після переходу за посиланням з листа на неї."""
        async with self._sessionmaker() as session, session.begin():
            taken = await session.scalar(select(User.id).where(User.email == email))
            if taken is not None and taken != user.id:
                raise AccountError("email_taken")
            # Попередні непідтверджені запити на зміну більше не діють.
            await session.execute(
                delete(AuthToken).where(
                    AuthToken.user_id == user.id, AuthToken.purpose == "verify_email"
                )
            )
            token = secrets.token_urlsafe(32)
            session.add(
                AuthToken(
                    token_hash=_hash(token),
                    user_id=user.id,
                    purpose="verify_email",
                    email=email,
                    expires_at=self._clock() + EMAIL_TOKEN_TTL,
                )
            )
        link = f"{self._settings.public_web_url}/auth/verify-email?token={token}"
        await self._send(
            email,
            "Підтвердіть адресу пошти",
            "Щоб прив'язати цю адресу до акаунта SkyPack, відкрийте посилання:\n"
            f"{link}\n\nПосилання діє 24 години. Якщо це були не ви — проігноруйте лист.",
        )

    async def verify_email(self, token: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            row = await self._take_token(session, token, "verify_email")
            taken = await session.scalar(
                select(User.id).where(User.email == row.email, User.id != row.user_id)
            )
            if taken is not None:
                raise AccountError("email_taken")
            await session.execute(
                update(User).where(User.id == row.user_id).values(email=row.email)
            )

    async def change_password(self, user: User, current: str | None, new: str, keep: str) -> None:
        """Змінює пароль і завершує всі інші сесії (`keep` — поточна)."""
        if user.password_hash is not None and not await verify_password(
            current or "", user.password_hash
        ):
            raise AccountError("wrong_password")
        new_hash = await hash_password(new)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(password_hash=new_hash)
            )
            await session.execute(
                delete(UserSession).where(
                    UserSession.user_id == user.id, UserSession.token_hash != _hash(keep)
                )
            )

    async def forgot_password(self, email: str) -> None:
        """Завжди «успіх»: не розкриваємо, чи є акаунт з такою адресою."""
        async with self._sessionmaker() as session, session.begin():
            user = await session.scalar(select(User).where(User.email == email.lower()))
            if user is None:
                return
            token = secrets.token_urlsafe(32)
            session.add(
                AuthToken(
                    token_hash=_hash(token),
                    user_id=user.id,
                    purpose="reset_password",
                    expires_at=self._clock() + RESET_TOKEN_TTL,
                )
            )
        link = f"{self._settings.public_web_url}/auth/reset?token={token}"
        await self._send(
            email,
            "Відновлення пароля",
            f"Щоб задати новий пароль, відкрийте посилання (діє 1 годину):\n{link}\n\n"
            "Якщо ви не просили відновлення — проігноруйте лист, пароль не зміниться.",
        )

    async def reset_password(self, token: str, new: str, device: str | None = None) -> SessionOut:
        new_hash = await hash_password(new)
        async with self._sessionmaker() as session, session.begin():
            row = await self._take_token(session, token, "reset_password")
            await session.execute(
                update(User).where(User.id == row.user_id).values(password_hash=new_hash)
            )
            # Скидання пароля — привід завершити всі старі сесії.
            await session.execute(delete(UserSession).where(UserSession.user_id == row.user_id))
            user_id = row.user_id
        return await self._new_session(user_id, device)

    async def delete_account(self, user: User, confirm: str) -> None:
        if user.password_hash is not None:
            if not await verify_password(confirm, user.password_hash):
                raise AccountError("wrong_password")
        elif confirm.strip().lower() != user.username:
            raise AccountError("wrong_password")
        # Усе інше (сесії, токени, історія, обране, поїздки, розмови, фото, підписки з їхнім
        # журналом) видаляє сама БД: зовнішні ключі ON DELETE CASCADE (міграція 0020).
        async with self._sessionmaker() as session, session.begin():
            await session.execute(delete(User).where(User.id == user.id))
        log.info("account.deleted")

    # --- історія й збережені пошуки ---------------------------------------------------

    async def record_search(self, user: User, body: SearchEntryBody) -> None:
        """Той самий пошук не дублюється — лише піднімається нагору історії."""
        now = self._clock()
        async with self._sessionmaker() as session, session.begin():
            existing = await session.scalar(
                select(SearchEntry).where(
                    SearchEntry.user_id == user.id,
                    SearchEntry.saved.is_(False),
                    SearchEntry.params == body.params,
                    SearchEntry.kind == body.kind,
                )
            )
            if existing is not None:
                existing.updated_at = now
                existing.title = body.title
                return
            session.add(_entry(user, body, now, saved=False))
            # Історія — не архів: найстаріші понад ліміт видаляємо.
            old = (
                await session.scalars(
                    select(SearchEntry.id)
                    .where(SearchEntry.user_id == user.id, SearchEntry.saved.is_(False))
                    .order_by(SearchEntry.updated_at.desc())
                    .offset(MAX_HISTORY - 1)
                )
            ).all()
            if old:
                await session.execute(delete(SearchEntry).where(SearchEntry.id.in_(old)))

    async def save_search(self, user: User, body: SearchEntryBody) -> SearchEntryOut:
        now = self._clock()
        async with self._sessionmaker() as session, session.begin():
            existing = await session.scalar(
                select(SearchEntry).where(
                    SearchEntry.user_id == user.id,
                    SearchEntry.saved.is_(True),
                    SearchEntry.params == body.params,
                    SearchEntry.kind == body.kind,
                )
            )
            if existing is not None:
                return _entry_out(existing)
            count = await session.scalar(
                select(func.count()).where(SearchEntry.user_id == user.id, SearchEntry.saved)
            )
            if (count or 0) >= MAX_SAVED:
                raise AccountError("limit_reached")
            entry = _entry(user, body, now, saved=True)
            session.add(entry)
        return _entry_out(entry)

    async def entries(self, user: User, *, saved: bool, limit: int = 50) -> list[SearchEntryOut]:
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(SearchEntry)
                    .where(SearchEntry.user_id == user.id, SearchEntry.saved.is_(saved))
                    .order_by(SearchEntry.updated_at.desc())
                    .limit(limit)
                )
            ).all()
        return [_entry_out(r) for r in rows]

    async def rename_entry(self, user: User, entry_id: str, title: str) -> SearchEntryOut:
        async with self._sessionmaker() as session, session.begin():
            entry = await session.get(SearchEntry, entry_id)
            if entry is None or entry.user_id != user.id:
                raise AccountError("not_found")
            entry.title = title
            entry.updated_at = self._clock()
            return _entry_out(entry)

    async def delete_entry(self, user: User, entry_id: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(SearchEntry).where(
                    SearchEntry.id == entry_id, SearchEntry.user_id == user.id
                )
            )

    async def clear_history(self, user: User) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(SearchEntry).where(
                    SearchEntry.user_id == user.id, SearchEntry.saved.is_(False)
                )
            )

    # --- обране (модуль 7) ----------------------------------------------------------------

    async def favorites(self, user: User) -> list[FavoriteOut]:
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(Favorite)
                    .where(Favorite.user_id == user.id)
                    .order_by(Favorite.created_at.desc())
                    .limit(MAX_FAVORITES)
                )
            ).all()
        return [_favorite_out(r) for r in rows]

    async def add_favorites(self, user: User, items: list[FavoriteBody]) -> list[FavoriteOut]:
        """Додає нові (той самий об'єкт на ті самі дати — не дублюється); понад ліміт —
        `limit_reached`, нічого не записавши."""
        now = self._clock()
        async with self._sessionmaker() as session, session.begin():
            existing = {
                (kind, key)
                for kind, key in (
                    await session.execute(
                        select(Favorite.kind, Favorite.item_key).where(Favorite.user_id == user.id)
                    )
                ).all()
            }
            fresh: dict[tuple[str, str], FavoriteBody] = {}
            for item in items:
                pair = (item.kind, item.item.item_key)
                if pair not in existing:
                    fresh.setdefault(pair, item)
            if len(existing) + len(fresh) > MAX_FAVORITES:
                raise AccountError("limit_reached")
            for (kind, key), item in fresh.items():
                session.add(
                    Favorite(
                        id=uuid.uuid4().hex,
                        user_id=user.id,
                        kind=kind,
                        item_key=key,
                        data=item.item.model_dump_json(),
                        created_at=now,
                    )
                )
        return await self.favorites(user)

    async def delete_favorite(self, user: User, item_key: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(Favorite).where(Favorite.user_id == user.id, Favorite.item_key == item_key)
            )

    # --- розмови з помічником (модуль 9c, лише за згодою) -----------------------------

    async def chats(self, user: User) -> ChatSyncState:
        if not user.chat_sync:
            return ChatSyncState(enabled=False)
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(ChatConversation)
                    .where(ChatConversation.user_id == user.id)
                    .order_by(ChatConversation.updated_at.desc())
                    .limit(MAX_SYNCED_CONVERSATIONS)
                )
            ).all()
        return ChatSyncState(
            enabled=True, conversations=[conversation_out(r.id, r.data) for r in rows]
        )

    async def set_chat_sync(self, user: User, enabled: bool) -> ChatSyncState:
        """Вимкнення — відкликання згоди: розмови з сервера видаляємо (у браузері лишаються)."""
        async with self._sessionmaker() as session, session.begin():
            await session.execute(update(User).where(User.id == user.id).values(chat_sync=enabled))
            if not enabled:
                await session.execute(
                    delete(ChatConversation).where(ChatConversation.user_id == user.id)
                )
        user.chat_sync = enabled
        return await self.chats(user)

    async def save_chat(
        self, user: User, conversation_id: str, body: ChatConversationBody
    ) -> ChatConversationOut:
        """Нова чи оновлена розмова; старіша за збережену — не перезаписує (інший пристрій
        уже зберіг новішу). Понад ліміт — найстаріші видаляються."""
        if not user.chat_sync:
            raise AccountError("not_found")
        changed = datetime.fromtimestamp(body.updated_at / 1000, tz=UTC)
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(ChatConversation, (user.id, conversation_id))
            if row is None:
                session.add(
                    ChatConversation(
                        user_id=user.id,
                        id=conversation_id,
                        data=body.model_dump_json(),
                        updated_at=changed,
                    )
                )
            elif _aware(row.updated_at) <= changed:
                row.data = body.model_dump_json()
                row.updated_at = changed
            else:
                return conversation_out(row.id, row.data)
            await session.flush()
            keep = (
                select(ChatConversation.id)
                .where(ChatConversation.user_id == user.id)
                .order_by(ChatConversation.updated_at.desc())
                .limit(MAX_SYNCED_CONVERSATIONS)
            )
            await session.execute(
                delete(ChatConversation).where(
                    ChatConversation.user_id == user.id, ChatConversation.id.not_in(keep)
                )
            )
        return ChatConversationOut(id=conversation_id, **body.model_dump())

    async def delete_chat(self, user: User, conversation_id: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(ChatConversation).where(
                    ChatConversation.user_id == user.id, ChatConversation.id == conversation_id
                )
            )

    # --- збережені поїздки (модуль 8c) ---------------------------------------------------

    async def saved_trips(self, user: User) -> list[SavedTripOut]:
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(SavedTrip)
                    .where(SavedTrip.user_id == user.id)
                    .order_by(SavedTrip.updated_at.desc())
                    .limit(MAX_SAVED_TRIPS)
                )
            ).all()
        return [_trip_out(r) for r in rows]

    async def save_trips(self, user: User, items: list[SavedTripBody]) -> list[SavedTripOut]:
        """Нові збережені поїздки (і «Створити копію», і перенесення з браузера). Понад
        ліміт — `limit_reached`, нічого не записавши."""
        now = self._clock()
        async with self._sessionmaker() as session, session.begin():
            count = await session.scalar(select(func.count()).where(SavedTrip.user_id == user.id))
            if (count or 0) + len(items) > MAX_SAVED_TRIPS:
                raise AccountError("limit_reached")
            rows = [
                SavedTrip(
                    id=uuid.uuid4().hex,
                    user_id=user.id,
                    title=item.title,
                    query=item.query.model_dump_json(),
                    snapshot=item.snapshot.model_dump_json(),
                    status=item.status,
                    created_at=now,
                    updated_at=now,
                )
                for item in items
            ]
            session.add_all(rows)
        return [_trip_out(r) for r in rows]

    async def update_trip(self, user: User, trip_id: str, body: SavedTripBody) -> SavedTripOut:
        """«Редагувати»: нова назва, конфігурація й знімок тієї самої поїздки (статус — окремо,
        `patch_trip`)."""
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(SavedTrip, trip_id)
            if row is None or row.user_id != user.id:
                raise AccountError("not_found")
            row.title = body.title
            row.query = body.query.model_dump_json()
            row.snapshot = body.snapshot.model_dump_json()
            # Статус не чіпаємо: «Зберегти зміни» з планувальника не скидає «Заплановану».
            row.updated_at = self._clock()
            return _trip_out(row)

    async def patch_trip(self, user: User, trip_id: str, patch: SavedTripPatch) -> SavedTripOut:
        """Назва чи статус (чернетка / запланована / архівна) — без зміни конфігурації."""
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(SavedTrip, trip_id)
            if row is None or row.user_id != user.id:
                raise AccountError("not_found")
            if patch.title is not None:
                row.title = patch.title
            if patch.status is not None:
                row.status = patch.status
            row.updated_at = self._clock()
            return _trip_out(row)

    async def delete_trip(self, user: User, trip_id: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(SavedTrip).where(SavedTrip.id == trip_id, SavedTrip.user_id == user.id)
            )

    async def alerts(self, user: User) -> list[AccountAlert]:
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(Alert)
                    .where(Alert.user_id == user.id)
                    .order_by(Alert.created_at.desc())
                    .limit(100)
                )
            ).all()
        return [AccountAlert.model_validate({**_columns(a), "manage_token": a.token}) for a in rows]

    # --- внутрішнє --------------------------------------------------------------------

    async def _new_session(self, user_id: str, device: str | None = None) -> SessionOut:
        token = secrets.token_urlsafe(32)
        now = self._clock()
        expires = now + timedelta(days=self._settings.session_ttl_days)
        async with self._sessionmaker() as session, session.begin():
            session.add(
                UserSession(
                    token_hash=_hash(token),
                    user_id=user_id,
                    created_at=now,
                    expires_at=expires,
                    device=device,
                    last_seen_at=now,
                )
            )
        return SessionOut(token=token, expires_at=expires)

    async def _take_token(self, session: AsyncSession, token: str, purpose: str) -> AuthToken:
        row = await session.get(AuthToken, _hash(token))
        if (
            row is None
            or row.purpose != purpose
            or row.used_at is not None
            or _aware(row.expires_at) <= self._clock()
        ):
            raise AccountError("invalid_token")
        row.used_at = self._clock()
        return row

    async def _send(self, to: str, subject: str, text: str) -> None:
        try:
            await self._mailer.send(to, subject, text)
        except MailError as exc:
            log.warning("account.mail_failed", error=str(exc))

    async def _failures(self, key: str) -> int:
        try:
            raw = await self._redis.get(key)
        except RedisError:
            return 0
        return int(raw) if raw else 0

    async def _fail(self, key: str) -> None:
        try:
            await self._redis.incr(key)
            await self._redis.expire(key, FAILURE_WINDOW_S)
        except RedisError as exc:
            log.warning("auth.fail_counter_unavailable", error=type(exc).__name__)

    async def _clear(self, key: str) -> None:
        with contextlib.suppress(RedisError):
            await self._redis.delete(key)


async def _free_username(session: AsyncSession, profile: GoogleProfile) -> str:
    """Логін для нового акаунта з Google: з email чи імені, з цифрами, якщо зайнято."""
    base_source = (profile.email or "").split("@")[0] or profile.given_name or "user"
    base = re.sub(r"[^a-z0-9_.]", "", base_source.lower())[:24] or "user"
    if len(base) < 3:
        base = f"{base}user"
    candidate = base
    for _ in range(20):
        taken = await session.scalar(select(User.id).where(User.username == candidate))
        if taken is None:
            return candidate
        candidate = f"{base}{secrets.randbelow(9000) + 1000}"
    return f"user{uuid.uuid4().hex[:12]}"


def _entry(user: User, body: SearchEntryBody, now: datetime, *, saved: bool) -> SearchEntry:
    return SearchEntry(
        id=uuid.uuid4().hex,
        user_id=user.id,
        kind=body.kind,
        params=body.params,
        title=body.title,
        saved=saved,
        created_at=now,
        updated_at=now,
    )


def _entry_out(entry: SearchEntry) -> SearchEntryOut:
    return SearchEntryOut.model_validate(entry, from_attributes=True)


def _trip_out(row: SavedTrip) -> SavedTripOut:
    return SavedTripOut(
        id=row.id,
        title=row.title,
        status=row.status if row.status in ("draft", "planned", "archived") else "draft",
        query=TripQuery.model_validate_json(row.query),
        snapshot=TripSnapshot.model_validate_json(row.snapshot),
        created_at=_aware(row.created_at),
        updated_at=_aware(row.updated_at),
    )


def _favorite_out(row: Favorite) -> FavoriteOut:
    item: FavoriteStay | FavoriteFlight | FavoriteTrip
    if row.kind == "flight":
        item = FavoriteFlight.model_validate_json(row.data)
    elif row.kind == "trip":
        item = FavoriteTrip.model_validate_json(row.data)
    else:
        item = FavoriteStay.model_validate_json(row.data)
    kind = row.kind if row.kind in ("flight", "trip") else "stay"
    return FavoriteOut.model_validate(
        {
            "id": row.id,
            "kind": kind,
            "item_key": row.item_key,
            kind: item,
            "created_at": _aware(row.created_at),
        }
    )


def _columns(alert: Alert) -> dict[str, object]:
    return {c.key: getattr(alert, c.key) for c in Alert.__table__.columns}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)
