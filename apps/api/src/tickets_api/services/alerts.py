"""Підписки на ціну (алерти): створення, підтвердження, перевірка за розкладом, сповіщення.

- Підписка з сайту підтверджується в Telegram (/start <код> з посилання) або листом
  (подвійна згода); з бота — одразу активна (людина вже в чаті). Керування — посилання з
  секретним токеном, кнопки в боті або кабінет (якщо підписку створено під час входу).
- Ціни для перевірок — окремий FlightSearchService з кешованим джерелом (ALERT_PROVIDERS),
  а не SerpApi: регулярні перевірки вичерпали б квоту.
- Без спаму: сповіщення лише коли ціна нижча за попередню надіслану і не частіше за
  ALERT_MIN_HOURS_BETWEEN_NOTIFICATIONS; «відкласти» — тиша до вказаної дати; минулі
  дати — підписка вимикається сама.

Діалоги бота (команди, кнопки, нова підписка в чаті) — services/telegram_bot.py.
"""

import contextlib
import secrets
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal
from urllib.parse import urlencode

import structlog
from pydantic import BaseModel
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.ai.explainer import money_text
from tickets_api.db.models import Alert, AlertEvent, User
from tickets_api.domain.alerts import (
    EDITABLE_FIELDS,
    SEARCH_FIELDS,
    TYPICAL_DISCOUNT_PERCENT,
    AlertChannel,
    AlertCreate,
    AlertEdit,
    AlertEventOut,
    AlertKind,
    AlertView,
    triggered,
)
from tickets_api.domain.flights import FlightQuery, Offer
from tickets_api.domain.notify import hold_reason, notify_prefs
from tickets_api.i18n import as_locale, t, use_locale
from tickets_api.notifications.mail import Mailer, MailError
from tickets_api.notifications.telegram import Button, Keyboard, TelegramClient, TelegramError, esc
from tickets_api.repositories.price_history import PriceStats
from tickets_api.scoring.engine import offer_key
from tickets_api.services.flight_search import FlightSearchResult, FlightSearchService

log = structlog.get_logger(__name__)

MIN_TYPICAL_SAMPLE = 20
"""«Нижче типової» має сенс лише з достатньою історією (як і оцінка ціни в поясненні)."""
SNOOZE_DAYS = 7

PriceStatsLookup = Callable[[FlightQuery, Decimal], Awaitable[PriceStats | None]]
Clock = Callable[[], datetime]
WEEKEND_DEPARTURE = frozenset({3, 4, 5})
"""Вихідні (flex, `weekends`): виліт чт–сб…"""
WEEKEND_RETURN = frozenset({5, 6, 0})
"""…і повернення сб–пн."""


@dataclass(frozen=True)
class Found:
    """Найкраща пропозиція перевірки: ціна за всіх і що показати в повідомленні."""

    price: Decimal
    departure: date | None = None
    return_date: date | None = None
    baggage_unknown: bool = False
    """Потрібен багаж, а його вартість невідома — ціна без багажу (чесна примітка)."""


PriceSource = Callable[[Alert], Awaitable[Found | None]]
"""Джерело ціни для типу підписки, якого не вміє пошук перельотів (житло, поїздка)."""


class ChannelStatus(BaseModel):
    telegram: Literal["live", "mock"]
    email: Literal["live", "mock"]
    bot_username: str | None
    kinds: list[AlertKind] = ["flight", "flex"]
    """Типи підписок, які зараз можна створити (житло й поїздка — лише з реальним джерелом)."""
    max_active_per_owner: int = 20
    """Скільки відкритих підписок можна мати (ТЗ 11.4: без безкінечного моніторингу)."""


SAME_ALERT_FIELDS = (
    "kind",
    "origin",
    "destination",
    "departure_date",
    "return_date",
    "departure_until",
    "min_nights",
    "max_nights",
    "weekends",
    "adults",
    "baggage",
    "stay_key",
    "condition",
    "threshold",
    "percent",
    "currency",
    "channel",
)
"""Однакова підписка — усі умови збігаються (власника перевіряємо окремо)."""


class AlertCreated(BaseModel):
    id: str
    status: str
    channel: AlertChannel
    manage_token: str
    """Секрет для сторінки керування — показується один раз, далі лише в посиланнях."""
    telegram_link: str | None = None
    """t.me/<бот>?start=<код> — відкрити, щоб підтвердити підписку."""
    existing: bool = False
    """Така сама підписка цього власника вже є — повертаємо її, а не дублюємо (модуль 16)."""


AlertErrorCode = Literal[
    "past_date", "kind_unavailable", "too_far", "closed", "owner_limit", "invalid"
]


class AlertError(ValueError):
    """Підписку не створити (минула дата, канал недоступний) — для API це 422.

    `code` — для UI (модуль 18.1): API віддає його в `detail`, веб показує текст своєю мовою;
    повідомлення — для логів і тестів."""

    def __init__(self, code: AlertErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AlertSettings:
    public_web_url: str
    bot_username: str | None
    min_hours_between_notifications: int
    check_interval_hours: int = 6
    max_searches_per_run: int = 300
    """Різних пошуків за одну перевірку (ТЗ 11.4); решта підписок — наступного разу."""
    max_active_per_owner: int = 20
    """Підписок (крім вимкнених і минулих) на акаунт, email чи Telegram-чат."""


MAX_HORIZON_DAYS = 365
"""Не стежимо за датами далі ніж за рік: кешованих цін там немає, а моніторинг — безстроковий."""
CHECK_EVENTS_KEEP_DAYS = 30
"""Журнал перевірок («checked») старший за 30 днів видаляємо — історія спрацювань лишається."""
RUN_LOCK_KEY = "alerts:check_all"
OPEN_STATUSES = ("pending", "active", "paused")


class BudgetExhaustedError(Exception):
    """Ліміт пошуків цієї перевірки вичерпано — підписку перевіримо наступного разу."""


@dataclass
class CheckRun:
    """Одна планова перевірка: однакові пошуки — один запит (ТЗ 11.4), ліміт запитів."""

    budget: int
    searches: int = 0
    results: dict[str, object] = field(default_factory=dict)

    def take(self) -> None:
        if self.searches >= self.budget:
            raise BudgetExhaustedError
        self.searches += 1


class AlertService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        search: FlightSearchService,
        telegram: TelegramClient,
        mailer: Mailer,
        settings: AlertSettings,
        price_stats: PriceStatsLookup | None = None,
        sources: Mapping[AlertKind, PriceSource] | None = None,
        redis: Redis | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._search = search
        self._telegram = telegram
        self._mailer = mailer
        self._settings = settings
        self._price_stats = price_stats
        self._sources: dict[AlertKind, PriceSource] = dict(sources or {})
        self._redis = redis
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def telegram(self) -> TelegramClient:
        return self._telegram

    @property
    def settings(self) -> AlertSettings:
        return self._settings

    def now(self) -> datetime:
        return self._clock()

    def channels(self) -> ChannelStatus:
        return ChannelStatus(
            telegram="mock" if self._telegram.name == "mock" else "live",
            email="mock" if self._mailer.name == "mock" else "live",
            bot_username=self._settings.bot_username,
            kinds=self.kinds(),
            max_active_per_owner=self._settings.max_active_per_owner,
        )

    def add_source(self, kind: AlertKind, source: PriceSource) -> None:
        self._sources[kind] = source

    def kinds(self) -> list[AlertKind]:
        """Перельоти — завжди (кешоване джерело); житло й поїздка — якщо є джерело ціни."""
        extra: list[AlertKind] = ["stay", "trip"]
        return ["flight", "flex", *(k for k in extra if k in self._sources)]

    # --- підписка ---------------------------------------------------------------------

    async def create(
        self,
        body: AlertCreate,
        user_id: str | None = None,
        *,
        chat_id: int | None = None,
    ) -> AlertCreated:
        """`user_id` — створено під час входу (видно в кабінеті); `chat_id` — створено в боті:
        людина вже в чаті, тож підписка активна одразу й перша перевірка — зараз."""
        if body.departure_date < self._clock().date():
            raise AlertError("past_date", "дата вильоту вже минула")
        if body.kind not in self.kinds():
            raise AlertError("kind_unavailable", "цей тип сповіщень поки недоступний")
        if body.departure_date > self._clock().date() + timedelta(days=MAX_HORIZON_DAYS):
            raise AlertError(
                "too_far", f"стежимо за датами не далі ніж на {MAX_HORIZON_DAYS} днів уперед"
            )
        if user_id is not None or chat_id is not None:
            same = await self._same_alert(body, user_id, chat_id)
            if same is not None:
                return AlertCreated(
                    id=same.id,
                    status=same.status,
                    channel=same.channel,
                    manage_token=same.token,
                    existing=True,
                )
        await self._check_owner_limit(user_id, body.email, chat_id)
        token = secrets.token_urlsafe(24)  # 32 символи [A-Za-z0-9_-]: годиться для /start
        active = chat_id is not None
        alert = Alert(
            id=uuid.uuid4().hex,
            token=token,
            kind=body.kind,
            origin=body.origin,
            destination=body.destination,
            departure_date=body.departure_date,
            return_date=body.return_date,
            departure_until=body.departure_until,
            min_nights=body.min_nights,
            max_nights=body.max_nights,
            weekends=body.weekends,
            adults=body.adults,
            baggage=body.baggage,
            stay_key=body.stay_key,
            condition=body.condition,
            threshold=body.threshold,
            percent=body.percent,
            currency=body.currency,
            channel=body.channel,
            email=body.email,
            telegram_chat_id=chat_id,
            locale=body.locale,
            status="active" if active else "pending",
            confirmed_at=self._clock() if active else None,
            user_id=user_id,
        )
        async with self._sessionmaker() as session, session.begin():
            session.add(alert)
            session.add(AlertEvent(alert_id=alert.id, kind="created"))
        link = None
        if active:
            await self._first_check(alert.id)
        elif body.channel == "telegram":
            bot = self._settings.bot_username or "your_bot"
            link = f"https://t.me/{bot}?start={token}"
        elif body.email is not None:
            with use_locale(body.locale):
                await self._send_mail(
                    body.email,
                    t("alerts.confirm.subject"),
                    confirm_email_text(alert, self.manage_url(token)),
                )
        return AlertCreated(
            id=alert.id,
            status=alert.status,
            channel=body.channel,
            manage_token=token,
            telegram_link=link,
        )

    async def _same_alert(
        self, body: AlertCreate, user_id: str | None, chat_id: int | None
    ) -> Alert | None:
        """Та сама жива підписка того самого власника. Лише для акаунта чи чату бота: їм токен
        і так належить. Анонімній email-підписці наявний токен не віддаємо — хто знає адресу,
        отримав би чужу підписку; там дубль відсіює підтвердження листом."""
        query = select(Alert).where(
            Alert.status.in_(("pending", "active", "paused")),
            *(
                getattr(Alert, f).is_(None)
                if getattr(body, f) is None
                else getattr(Alert, f) == getattr(body, f)
                for f in SAME_ALERT_FIELDS
            ),
        )
        if user_id is not None:
            query = query.where(Alert.user_id == user_id)
        else:
            query = query.where(Alert.telegram_chat_id == chat_id)
        async with self._sessionmaker() as session:
            return await session.scalar(query.order_by(Alert.created_at).limit(1))

    async def view(self, token: str) -> AlertView | None:
        async with self._sessionmaker() as session:
            alert = await _by_token(session, token)
            return _view(alert) if alert else None

    async def confirm_email(self, token: str) -> AlertView | None:
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return None
            confirmed = alert.channel == "email" and alert.status == "pending"
            if confirmed:
                alert.status = "active"
                alert.confirmed_at = self._clock()
                session.add(AlertEvent(alert_id=alert.id, kind="confirmed"))
            alert_id = alert.id
        if confirmed:
            await self._first_check(alert_id)
        return await self.view(token)

    async def bind_telegram(self, token: str, chat_id: int) -> Alert | None:
        """/start <код> з посилання сайту: прив'язати чат і активувати. None — код не діє."""
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None or alert.channel != "telegram" or alert.status != "pending":
                return None
            alert.telegram_chat_id = chat_id
            alert.status = "active"
            alert.confirmed_at = self._clock()
            session.add(AlertEvent(alert_id=alert.id, kind="confirmed"))
        return alert

    async def stop(self, token: str) -> AlertView | None:
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return None
            _stop(session, alert)
            return _view(alert)

    # --- керування (11.3): за токеном — і з кабінету, і з посилання ------------------

    async def pause(self, token: str) -> AlertView | None:
        return await self._set_status(token, frm=("active",), to="paused", event="paused")

    async def resume(self, token: str) -> AlertView | None:
        """Відновити; дати вже минули — підписка стає «минулою», а не активною."""
        view = await self._set_status(token, frm=("paused",), to="active", event="resumed")
        if view is not None and view.status == "active":
            async with self._sessionmaker() as session:
                alert = await _by_token(session, token)
                alert_id = alert.id if alert else None
            if alert_id:
                await self._first_check(alert_id)
            return await self.view(token)
        return view

    async def delete(self, token: str) -> bool:
        """Видалити підписку разом з історією (GDPR: контакт теж зникає)."""
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return False
            await session.execute(delete(AlertEvent).where(AlertEvent.alert_id == alert.id))
            await session.delete(alert)
        return True

    async def update(self, token: str, edit: AlertEdit) -> AlertView | None:
        """Змінити дати, людей, багаж чи умову. Інший пошук — ціни й база починаються заново;
        інша умова — попереднє сповіщення більше не рахується."""
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return None
            if alert.status in ("stopped", "expired"):
                raise AlertError("closed", "вимкнену чи минулу підписку не змінити — створіть нову")
            merged = {**_create_fields(alert), **edit.model_dump()}
            try:
                body = AlertCreate.model_validate(merged)
            except ValueError as exc:
                raise AlertError("invalid", _first_error(exc)) from exc
            if body.departure_date < self._clock().date():
                raise AlertError("past_date", "дата вильоту вже минула")
            if body.departure_date > self._clock().date() + timedelta(days=MAX_HORIZON_DAYS):
                raise AlertError(
                    "too_far", f"стежимо за датами не далі ніж на {MAX_HORIZON_DAYS} днів уперед"
                )
            changed = {f for f in EDITABLE_FIELDS if getattr(alert, f) != getattr(body, f)}
            if not changed:
                return _view(alert)
            for name in EDITABLE_FIELDS:
                setattr(alert, name, getattr(body, name))
            if changed & SEARCH_FIELDS:
                alert.baseline_price = None
                alert.last_price = None
            alert.last_notified_price = None
            alert.last_notified_at = None
            session.add(
                AlertEvent(alert_id=alert.id, kind="edited", detail=",".join(sorted(changed)))
            )
            active = alert.status == "active"
            alert_id = alert.id
        if active:
            await self._first_check(alert_id)
        return await self.view(token)

    async def history(self, token: str, limit: int = 50) -> list[AlertEventOut] | None:
        """Спрацювання, затримки й зміни статусу — без рядових перевірок (їх лише лічимо)."""
        async with self._sessionmaker() as session:
            alert = await _by_token(session, token)
            if alert is None:
                return None
            rows = (
                await session.scalars(
                    select(AlertEvent)
                    .where(AlertEvent.alert_id == alert.id, AlertEvent.kind != "checked")
                    .order_by(AlertEvent.created_at.desc(), AlertEvent.id.desc())
                    .limit(limit)
                )
            ).all()
        return [AlertEventOut.model_validate(r, from_attributes=True) for r in rows]

    async def _set_status(
        self, token: str, *, frm: tuple[str, ...], to: str, event: str
    ) -> AlertView | None:
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return None
            if alert.status in frm:
                today = self._clock().date()
                if to == "active" and (alert.departure_until or alert.departure_date) < today:
                    alert.status = "expired"
                    session.add(AlertEvent(alert_id=alert.id, kind="expired"))
                else:
                    alert.status = to
                    session.add(AlertEvent(alert_id=alert.id, kind=event))
            return _view(alert)

    async def _check_owner_limit(
        self, user_id: str | None, email: str | None, chat_id: int | None
    ) -> None:
        """Не безстроковий моніторинг (ТЗ 11.4): обмежена кількість відкритих підписок."""
        owners = [
            cond
            for cond, value in (
                (Alert.user_id == user_id, user_id),
                (Alert.email == email, email),
                (Alert.telegram_chat_id == chat_id, chat_id),
            )
            if value is not None
        ]
        if not owners:
            return
        async with self._sessionmaker() as session:
            count = await session.scalar(
                select(func.count(Alert.id)).where(Alert.status.in_(OPEN_STATUSES), or_(*owners))
            )
        if (count or 0) >= self._settings.max_active_per_owner:
            raise AlertError(
                "owner_limit",
                f"забагато підписок: до {self._settings.max_active_per_owner} відкритих — "
                "вимкніть чи видаліть зайві",
            )

    # --- керування з бота (лише власний чат) ------------------------------------------

    async def chat_alerts(self, chat_id: int) -> list[Alert]:
        async with self._sessionmaker() as session:
            return list(
                (
                    await session.scalars(
                        select(Alert)
                        .where(Alert.telegram_chat_id == chat_id, Alert.status == "active")
                        .order_by(Alert.departure_date)
                    )
                ).all()
            )

    async def chat_alert(self, chat_id: int, alert_id: str) -> Alert | None:
        async with self._sessionmaker() as session:
            alert = await session.get(Alert, alert_id)
        return alert if alert is not None and alert.telegram_chat_id == chat_id else None

    async def stop_for_chat(self, chat_id: int, alert_id: str | None = None) -> int:
        """Вимкнути одну (alert_id) чи всі активні підписки чату. Повертає к-сть."""
        async with self._sessionmaker() as session, session.begin():
            query = select(Alert).where(Alert.telegram_chat_id == chat_id, Alert.status == "active")
            if alert_id is not None:
                query = query.where(Alert.id == alert_id)
            alerts = (await session.scalars(query)).all()
            for alert in alerts:
                _stop(session, alert)
        return len(alerts)

    async def snooze_for_chat(self, chat_id: int, alert_id: str) -> date | None:
        """Тиша на SNOOZE_DAYS днів (сповіщень не буде, перевірки — так). Повертає «до»."""
        until = (self._clock() + timedelta(days=SNOOZE_DAYS)).date()
        async with self._sessionmaker() as session, session.begin():
            alert = await session.get(Alert, alert_id)
            if alert is None or alert.telegram_chat_id != chat_id or alert.status != "active":
                return None
            alert.snoozed_until = until
            session.add(AlertEvent(alert_id=alert.id, kind="snoozed", detail=until.isoformat()))
        return until

    async def set_threshold_for_chat(self, chat_id: int, alert_id: str, threshold: int) -> bool:
        async with self._sessionmaker() as session, session.begin():
            alert = await session.get(Alert, alert_id)
            if alert is None or alert.telegram_chat_id != chat_id or alert.status != "active":
                return False
            alert.condition = "below_price"
            alert.threshold = threshold
            # Новий поріг — нова точка відліку: попередня надіслана ціна вже не бар'єр.
            alert.last_notified_price = None
            alert.last_notified_at = None
            session.add(AlertEvent(alert_id=alert.id, kind="threshold", detail=str(threshold)))
        await self._first_check(alert_id)
        return True

    # --- перевірка цін ----------------------------------------------------------------

    async def check_all(self) -> int:
        """Планова перевірка активних підписок (ТЗ 11.4). Повертає к-сть надісланих сповіщень.

        - одна перевірка за раз (замок у Redis), свіжоперевірені (півінтервалу) пропускаємо —
          запуск при старті воркера й за розкладом не дублюють запити;
        - однакові пошуки — один запит; не більше `max_searches_per_run` різних пошуків,
          решта — наступного разу (спершу ті, що чекали найдовше);
        - старий журнал рядових перевірок прибираємо.
        """
        if not await self._lock_run():
            log.info("alerts.check_skipped_running")
            return 0
        try:
            now = self._clock()
            fresh = now - timedelta(hours=self._settings.check_interval_hours / 2)
            async with self._sessionmaker() as session:
                ids = (
                    await session.scalars(
                        select(Alert.id)
                        .where(
                            Alert.status == "active",
                            or_(Alert.last_checked_at.is_(None), Alert.last_checked_at < fresh),
                        )
                        .order_by(Alert.last_checked_at.asc().nulls_first())
                    )
                ).all()
            run = CheckRun(budget=self._settings.max_searches_per_run)
            sent = deferred = 0
            for alert_id in ids:
                try:
                    sent += await self.check(alert_id, run)
                except BudgetExhaustedError:
                    deferred += 1
                except Exception:  # одна підписка не зупиняє решту
                    log.exception("alerts.check_failed", alert_id=alert_id)
            await self._prune(now)
            log.info(
                "alerts.run", alerts=len(ids), searches=run.searches, deferred=deferred, sent=sent
            )
            return sent
        finally:
            await self._unlock_run()

    async def _lock_run(self) -> bool:
        if self._redis is None:
            return True
        ttl = int(self._settings.check_interval_hours * 3600)
        try:
            return bool(await self._redis.set(RUN_LOCK_KEY, "1", nx=True, ex=ttl))
        except RedisError:
            return True  # без Redis — без замка (graceful degradation)

    async def _unlock_run(self) -> None:
        if self._redis is None:
            return
        with contextlib.suppress(RedisError):
            await self._redis.delete(RUN_LOCK_KEY)

    async def _prune(self, now: datetime) -> None:
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                delete(AlertEvent).where(
                    AlertEvent.kind == "checked",
                    AlertEvent.created_at < now - timedelta(days=CHECK_EVENTS_KEEP_DAYS),
                )
            )

    async def check(self, alert_id: str, run: CheckRun | None = None) -> int:
        now = self._clock()
        async with self._sessionmaker() as session:
            alert = await session.get(Alert, alert_id)
            if alert is None or alert.status != "active":
                return 0
            # Тексти сповіщення — мовою підписки (модуль 18.1).
            with use_locale(as_locale(alert.locale)):
                if (alert.departure_until or alert.departure_date) < now.date():
                    alert.status = "expired"
                    session.add(AlertEvent(alert_id=alert.id, kind="expired"))
                    await session.commit()
                    return 0
                found = await self._best(alert, run)
                best = found.price if found else None
                alert.last_checked_at = now
                alert.last_price = best
                if best is not None and alert.baseline_price is None:
                    alert.baseline_price = best  # від неї — зниження на суму / відсоток
                session.add(AlertEvent(alert_id=alert.id, kind="checked", price=best))
                reason = await self._reason(alert, best)
                snoozed = alert.snoozed_until is not None and now.date() < alert.snoozed_until
                notify = reason is not None and not snoozed and self._may_notify(alert, now)
                previous = alert.last_notified_price
                if notify and best is not None and alert.user_id is not None:
                    held = await self._held_by_owner(session, alert, best, now)
                    if held is not None:
                        session.add(AlertEvent(alert_id=alert.id, kind="held", detail=held))
                        notify = False
                await session.commit()
                if not notify or found is None or reason is None:
                    return 0
                delivered = await self._notify(alert, found, reason, previous)
                if delivered:
                    alert.last_notified_price = found.price
                    alert.last_notified_at = now
                    session.add(AlertEvent(alert_id=alert.id, kind="notified", price=found.price))
                    await session.commit()
                return int(delivered)

    async def _best(self, alert: Alert, run: CheckRun | None = None) -> Found | None:
        if alert.kind in ("flight", "flex"):
            return await self._best_flight(alert, run)
        source = next((f for k, f in self._sources.items() if k == alert.kind), None)
        if source is None:
            return None
        if run is None:
            return await source(alert)
        key = _alert_key(alert)
        if key not in run.results:
            run.take()
            run.results[key] = await source(alert)
        cached = run.results[key]
        return cached if isinstance(cached, Found) else None

    async def best_flight(self, alert: Alert) -> Found | None:
        """Ціна перельоту для підписки — і для джерела «поїздка» (переліт + житло)."""
        return await self._best_flight(alert)

    async def _best_flight(self, alert: Alert, run: CheckRun | None = None) -> Found | None:
        """Найдешевша пропозиція у валюті підписки. Потрібен багаж і його вартість відома —
        порівнюємо кінцеву суму; невідома — ціну квитків з приміткою; тариф без такого
        багажу — пропускаємо."""
        query = flight_query(alert)
        result = await self._search_once(query, run)
        best: Found | None = None
        for offer in result.offers:
            if offer.currency != alert.currency or (alert.weekends and not _weekend(offer)):
                continue
            cost = result.baggage.get(offer_key(offer))
            if cost is not None and cost.status == "not_available":
                continue
            known = cost is not None and cost.total is not None
            price = cost.total if known and cost is not None and cost.total else offer.price
            if best is None or price < best.price:
                best = Found(
                    price=price,
                    departure=offer.outbound.departure_at.date(),
                    return_date=offer.inbound.departure_at.date() if offer.inbound else None,
                    baggage_unknown=alert.baggage != "none" and not known,
                )
        return best

    async def _search_once(self, query: FlightQuery, run: CheckRun | None) -> FlightSearchResult:
        """Однаковий запит у межах перевірки — один пошук (а джерело ще й кешоване в Redis)."""
        if run is None:
            return await self._search.search(query)
        key = query.model_dump_json()
        cached = run.results.get(key)
        if isinstance(cached, FlightSearchResult):
            return cached
        run.take()
        result = await self._search.search(query)
        run.results[key] = result
        return result

    async def _reason(self, alert: Alert, best: Decimal | None) -> str | None:
        """Чому сповіщаємо (текст для повідомлення) або None: умова не виконана чи це не нова
        істотна зміна відносно минулого сповіщення."""
        if best is None:
            return None
        limit: Decimal | None = None
        median: Decimal | None = None
        if alert.condition == "below_typical" and self._price_stats is not None:
            stats = await self._price_stats(flight_query(alert), best)
            if stats is not None and stats.sample_size >= MIN_TYPICAL_SAMPLE:
                median = stats.median
                limit = stats.median * (Decimal(100 - TYPICAL_DISCOUNT_PERCENT) / 100)
        if not triggered(
            alert.condition,  # type: ignore[arg-type]
            best=best,
            threshold=alert.threshold,
            percent=alert.percent,
            baseline=alert.baseline_price,
            previous=alert.last_notified_price,
            typical_limit=limit,
        ):
            return None
        if alert.condition == "below_price":
            return t("alerts.reason.below_price", amount=_money(alert, alert.threshold or 0))
        if alert.condition == "below_typical":
            return t("alerts.reason.below_typical", amount=_money(alert, median or 0))
        base = alert.baseline_price or best
        return t("alerts.reason.drop", amount=_money(alert, base - best), base=_money(alert, base))

    async def _held_by_owner(
        self, session: AsyncSession, alert: Alert, best: Decimal, now: datetime
    ) -> str | None:
        """Налаштування сповіщень власника (модуль 10c): канал, категорія, частота, тиша."""
        raw = await session.scalar(select(User.notify_prefs).where(User.id == alert.user_id))
        prefs = notify_prefs(raw)
        last = alert.last_notified_at
        return hold_reason(
            prefs,
            channel=alert.channel,
            condition=alert.condition,
            best=best,
            previous=alert.last_notified_price,
            hours_since_last=(now - _aware(last)).total_seconds() / 3600 if last else None,
            now=now,
        )

    def _may_notify(self, alert: Alert, now: datetime) -> bool:
        """Глобальна пауза між сповіщеннями однієї підписки (ціну перевіряє `triggered`)."""
        if alert.last_notified_at is None:
            return True
        pause = timedelta(hours=self._settings.min_hours_between_notifications)
        return now - _aware(alert.last_notified_at) >= pause

    async def _notify(
        self, alert: Alert, best: Found, reason: str, previous: Decimal | None
    ) -> bool:
        search_url = self.search_url(alert, best)
        manage_url = self.manage_url(alert.token)
        if alert.channel == "telegram" and alert.telegram_chat_id is not None:
            return await self.reply(
                alert.telegram_chat_id,
                price_drop_html(alert, best, reason, previous, search_url, manage_url),
                alert_keyboard(alert, search_url, manage_url, snooze=True),
                html=True,
            )
        if alert.channel == "email" and alert.email:
            text = price_drop_text(alert, best, reason, search_url, manage_url)
            subject = t("alerts.drop.subject", route=route_text(alert))
            return await self._send_mail(alert.email, subject, text)
        return False

    async def _first_check(self, alert_id: str) -> None:
        """Одразу після підтвердження — перша перевірка: якщо ціна вже нижча за поріг,
        людина дізнається зараз, а не за кілька годин до наступної планової перевірки."""
        try:
            await self.check(alert_id)
        except Exception:  # підтвердження вже відбулося — перевірка повториться за розкладом
            log.exception("alerts.first_check_failed", alert_id=alert_id)

    # --- спільне з ботом --------------------------------------------------------------

    def manage_url(self, token: str) -> str:
        return f"{self._settings.public_web_url}/alerts?token={token}"

    def search_url(self, alert: Alert, found: Found | None = None) -> str:
        """Сторінка результатів для підписки; знайдено конкретні дати (flex) — саме на них."""
        base = self._settings.public_web_url
        depart = found.departure if found and found.departure else alert.departure_date
        back = found.return_date if found and found.departure else alert.return_date
        if alert.kind == "stay":
            params = {"city": alert.destination, "in": alert.departure_date}
            params |= {"out": alert.return_date, "adults": alert.adults}
            return f"{base}/stays?{urlencode(params)}"
        query: dict[str, object] = {"from": alert.origin, "to": alert.destination}
        if alert.kind == "flex" and not (found and found.departure):
            query |= {"depart": alert.departure_date, "flex": "range"}
            query |= {"until": alert.departure_until, "nmin": alert.min_nights}
            query["nmax"] = alert.max_nights or alert.min_nights
        else:
            query["depart"] = depart
            if back:
                query["return"] = back
        if alert.adults > 1:
            query["adults"] = alert.adults
        if alert.baggage != "none":
            query["bag"] = alert.baggage
        if alert.kind == "trip":
            return f"{base}/trip?{urlencode(query)}"
        return f"{base}/?{urlencode(query)}"

    async def reply(
        self, chat_id: int, text: str, keyboard: Keyboard = (), *, html: bool = False
    ) -> bool:
        try:
            await self._telegram.send_message(chat_id, text, keyboard, html=html)
        except TelegramError as exc:
            log.warning("alerts.telegram_send_failed", error=str(exc))
            return False
        return True

    async def _send_mail(self, to: str, subject: str, text: str) -> bool:
        try:
            await self._mailer.send(to, subject, text)
        except MailError as exc:
            log.warning("alerts.mail_failed", error=str(exc))
            return False
        return True


def flight_query(alert: Alert) -> FlightQuery:
    """Запит пошуку для підписки на переліт; flex — період вильоту й ночі (ADR 0016)."""
    flex = alert.kind == "flex" and alert.departure_until is not None and alert.min_nights
    return FlightQuery(
        origin=alert.origin or "",
        destination=alert.destination,
        departure_date=alert.departure_date,
        return_date=(
            alert.departure_date + timedelta(days=alert.min_nights or 1)
            if flex
            else alert.return_date
        ),
        departure_until=alert.departure_until if flex else None,
        min_nights=alert.min_nights if flex else None,
        max_nights=(alert.max_nights or alert.min_nights) if flex else None,
        passengers={"adults": alert.adults},
        baggage=alert.baggage,
        currency=alert.currency,
    )


def _weekend(offer: Offer) -> bool:
    if offer.inbound is None:
        return False
    return (
        offer.outbound.departure_at.weekday() in WEEKEND_DEPARTURE
        and offer.inbound.departure_at.weekday() in WEEKEND_RETURN
    )


def _stop(session: AsyncSession, alert: Alert) -> None:
    if alert.status in ("pending", "active"):
        alert.status = "stopped"
        session.add(AlertEvent(alert_id=alert.id, kind="stopped"))


async def _by_token(session: AsyncSession, token: str) -> Alert | None:
    if not token or len(token) > 64:
        return None
    return await session.scalar(select(Alert).where(Alert.token == token))


def _create_fields(alert: Alert) -> dict[str, object]:
    """Поля підписки у формі AlertCreate — щоб перевірити редагування тими самими правилами."""
    names = AlertCreate.model_fields.keys()
    return {name: getattr(alert, name) for name in names if hasattr(alert, name)}


def _first_error(exc: ValueError) -> str:
    errors = getattr(exc, "errors", None)
    if callable(errors):
        first = errors()[0] if errors() else None
        if first:
            return str(first.get("msg", "")).removeprefix("Value error, ")
    return str(exc)


def _alert_key(alert: Alert) -> str:
    fields = [alert.kind, alert.origin, alert.destination, alert.currency, alert.stay_key]
    fields += [getattr(alert, f) for f in sorted(SEARCH_FIELDS)]
    return "|".join(str(v) for v in fields)


def _view(alert: Alert) -> AlertView:
    return AlertView.model_validate(alert, from_attributes=True)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


# --- тексти повідомлень (українською) -----------------------------------------------


def _date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def route_text(alert: Alert) -> str:
    if alert.kind == "flex" and alert.departure_until:
        nights = f"{alert.min_nights}"
        if alert.max_nights and alert.max_nights != alert.min_nights:
            nights += f"–{alert.max_nights}"
        dates = t(
            "alerts.route.flex",
            start=_date(alert.departure_date),
            end=_date(alert.departure_until),
            nights=nights,
        )
        if alert.weekends:
            dates += t("alerts.route.weekends")
    else:
        dates = _date(alert.departure_date)
        if alert.return_date:
            dates += f" – {_date(alert.return_date)}"
    if alert.kind == "stay":
        return t("alerts.route.stay", city=alert.destination, dates=dates)
    route = f"{alert.origin} → {alert.destination}, {dates}"
    return t("alerts.route.trip", route=route) if alert.kind == "trip" else route


def party_text(alert: Alert) -> str:
    if alert.kind == "stay":
        return t("alerts.party.stay")
    return t("alerts.party.adults", count=alert.adults)


def _money(alert: Alert, value: Decimal | int) -> str:
    return money_text(Decimal(value), alert.currency)


def condition_text(alert: Alert) -> str:
    if alert.condition == "below_price" and alert.threshold is not None:
        amount = _money(alert, alert.threshold)
        return t("alerts.condition.below_price", amount=amount, party=party_text(alert))
    if alert.condition == "drop_amount" and alert.threshold is not None:
        return t("alerts.condition.drop_amount", amount=_money(alert, alert.threshold))
    if alert.condition == "drop_percent" and alert.percent is not None:
        return t("alerts.condition.drop_percent", percent=alert.percent)
    return t("alerts.condition.below_typical", percent=TYPICAL_DISCOUNT_PERCENT)


def found_lines(alert: Alert, best: Found) -> list[str]:
    """Дати знайденої пропозиції (гнучкі дати) і чесна примітка про невідомий багаж."""
    lines = []
    if alert.kind == "flex" and best.departure:
        dates = _date(best.departure)
        if best.return_date:
            dates += f" – {_date(best.return_date)}"
        lines.append(t("alerts.found.dates", dates=dates))
    if best.baggage_unknown:
        lines.append(t("alerts.found.baggage_unknown"))
    return lines


def alert_keyboard(
    alert: Alert, search_url: str, manage_url: str, *, snooze: bool = False
) -> list[list[Button]]:
    """Кнопки під повідомленням про підписку. Посилання — лише якщо сайт на https."""
    actions = [Button(t("alerts.button.stop"), data=f"stop:{alert.id}")]
    if snooze:
        actions.append(
            Button(t("alerts.button.snooze", count=SNOOZE_DAYS), data=f"snooze:{alert.id}")
        )
    else:
        actions.append(Button(t("alerts.button.threshold"), data=f"thr:{alert.id}"))
    return [
        [
            Button(t("alerts.button.tickets"), url=search_url),
            Button(t("alerts.button.manage"), url=manage_url),
        ],
        actions,
    ]


def links_html(search_url: str, manage_url: str) -> str:
    """Поки сайт не на https, кнопки-посилання Telegram не приймає — даємо посилання текстом."""
    if search_url.startswith("https://"):
        return ""
    return t("alerts.links", search=esc(search_url), manage=esc(manage_url))


def price_drop_html(
    alert: Alert,
    found: Found,
    reason: str,
    previous: Decimal | None,
    search_url: str,
    manage_url: str,
) -> str:
    best = found.price
    lines = [
        t("alerts.drop.title_html"),
        f"<b>{esc(route_text(alert))}</b>",
        "",
        t(
            "alerts.drop.now_html",
            price=esc(money_text(best, alert.currency)),
            party=esc(party_text(alert)),
            reason=esc(reason),
        ),
        *(esc(line) for line in found_lines(alert, found)),
    ]
    if previous is not None and previous > best:
        lines.append(
            esc(
                t(
                    "alerts.drop.previous",
                    previous=money_text(previous, alert.currency),
                    diff=money_text(previous - best, alert.currency),
                )
            )
        )
    lines.append(t("alerts.drop.note_html"))
    return "\n".join(lines) + links_html(search_url, manage_url)


def confirm_email_text(alert: Alert, manage_url: str) -> str:
    return t(
        "alerts.confirm.email",
        route=route_text(alert),
        condition=condition_text(alert),
        manage=manage_url,
    )


def price_drop_text(
    alert: Alert, found: Found, reason: str, search_url: str, manage_url: str
) -> str:
    return t(
        "alerts.drop.email",
        route=route_text(alert),
        price=money_text(found.price, alert.currency),
        party=party_text(alert),
        reason=reason,
        extra="".join(f"{line}\n" for line in found_lines(alert, found)),
        search=search_url,
        manage=manage_url,
    )
