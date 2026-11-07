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
from tickets_api.db.models import Alert, AlertEvent, AuthToken, SearchEntry, User, UserSession
from tickets_api.domain.accounts import (
    Account,
    AccountAlert,
    GoogleStart,
    RegisterBody,
    SearchEntryBody,
    SearchEntryOut,
    SessionOut,
)
from tickets_api.notifications.mail import Mailer, MailError

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
]


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

    async def register(self, body: RegisterBody) -> SessionOut:
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
        return await self._new_session(user.id)

    async def login(self, login: str, password: str) -> SessionOut:
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
        return await self._new_session(user.id)

    async def user_for_session(self, token: str) -> User | None:
        async with self._sessionmaker() as session:
            row = await session.get(UserSession, _hash(token))
            if row is None or _aware(row.expires_at) <= self._clock():
                return None
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

    async def google_callback(self, code: str, state: str) -> tuple[SessionOut | None, str]:
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
        return await self._new_session(user_id), "login"

    async def _link_google(self, user_id: str, profile: GoogleProfile) -> None:
        async with self._sessionmaker() as session, session.begin():
            owner = await session.scalar(select(User).where(User.google_sub == profile.sub))
            if owner is not None and owner.id != user_id:
                raise AccountError("google_taken")
            user = await session.get(User, user_id)
            if user is None:
                raise AccountError("not_found")
            user.google_sub = profile.sub
            if user.email is None and profile.email and profile.email_verified:
                taken = await session.scalar(select(User.id).where(User.email == profile.email))
                if taken is None:
                    user.email = profile.email

    async def _google_user(self, profile: GoogleProfile) -> str:
        async with self._sessionmaker() as session, session.begin():
            user = await session.scalar(select(User).where(User.google_sub == profile.sub))
            if user is not None:
                return user.id
            # Той самий ПІДТВЕРДЖЕНИЙ email (і в Google, і в нас) — це той самий власник.
            if profile.email and profile.email_verified:
                user = await session.scalar(select(User).where(User.email == profile.email))
                if user is not None:
                    user.google_sub = profile.sub
                    return user.id
            user = User(
                id=uuid.uuid4().hex,
                username=await _free_username(session, profile),
                first_name=profile.given_name,
                last_name=profile.family_name,
                email=profile.email if profile.email and profile.email_verified else None,
                google_sub=profile.sub,
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
            await session.execute(update(User).where(User.id == user.id).values(google_sub=None))

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
            created_at=user.created_at,
        )

    async def update_profile(self, user: User, first: str | None, last: str | None) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(User).where(User.id == user.id).values(first_name=first, last_name=last)
            )

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
            "Щоб прив'язати цю адресу до акаунта Tickets, відкрийте посилання:\n"
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

    async def reset_password(self, token: str, new: str) -> SessionOut:
        new_hash = await hash_password(new)
        async with self._sessionmaker() as session, session.begin():
            row = await self._take_token(session, token, "reset_password")
            await session.execute(
                update(User).where(User.id == row.user_id).values(password_hash=new_hash)
            )
            # Скидання пароля — привід завершити всі старі сесії.
            await session.execute(delete(UserSession).where(UserSession.user_id == row.user_id))
            user_id = row.user_id
        return await self._new_session(user_id)

    async def delete_account(self, user: User, confirm: str) -> None:
        if user.password_hash is not None:
            if not await verify_password(confirm, user.password_hash):
                raise AccountError("wrong_password")
        elif confirm.strip().lower() != user.username:
            raise AccountError("wrong_password")
        async with self._sessionmaker() as session, session.begin():
            alert_ids = (
                await session.scalars(select(Alert.id).where(Alert.user_id == user.id))
            ).all()
            await session.execute(delete(AlertEvent).where(AlertEvent.alert_id.in_(alert_ids)))
            await session.execute(delete(Alert).where(Alert.user_id == user.id))
            for model in (SearchEntry, AuthToken, UserSession):
                await session.execute(delete(model).where(model.user_id == user.id))
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

    async def _new_session(self, user_id: str) -> SessionOut:
        token = secrets.token_urlsafe(32)
        expires = self._clock() + timedelta(days=self._settings.session_ttl_days)
        async with self._sessionmaker() as session, session.begin():
            session.add(UserSession(token_hash=_hash(token), user_id=user_id, expires_at=expires))
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


def _columns(alert: Alert) -> dict[str, object]:
    return {c.key: getattr(alert, c.key) for c in Alert.__table__.columns}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)
