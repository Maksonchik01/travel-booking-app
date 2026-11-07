"""Підписки на ціну (алерти): створення, підтвердження, перевірка за розкладом, сповіщення.

- Без акаунтів: підписка підтверджується в Telegram (/start <код> з посилання) або листом
  (подвійна згода). Керування — за посиланням із секретним токеном.
- Ціни для перевірок — окремий FlightSearchService з кешованим джерелом (ALERT_PROVIDERS),
  а не SerpApi: регулярні перевірки вичерпали б квоту.
- Без спаму: сповіщення лише коли ціна нижча за попередню надіслану і не частіше за
  ALERT_MIN_HOURS_BETWEEN_NOTIFICATIONS; минулі дати — підписка вимикається сама.
"""

import secrets
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

import structlog
from pydantic import BaseModel
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.ai.explainer import money_text
from tickets_api.db.models import Alert, AlertEvent
from tickets_api.domain.alerts import (
    TYPICAL_DISCOUNT_PERCENT,
    AlertChannel,
    AlertCreate,
    AlertView,
)
from tickets_api.domain.flights import FlightQuery
from tickets_api.notifications.mail import Mailer, MailError
from tickets_api.notifications.telegram import TelegramClient, TelegramError
from tickets_api.repositories.price_history import PriceStats
from tickets_api.services.flight_search import FlightSearchService

log = structlog.get_logger(__name__)

TELEGRAM_OFFSET_KEY = "alerts:telegram:offset"
MIN_TYPICAL_SAMPLE = 20
"""«Нижче типової» має сенс лише з достатньою історією (як і оцінка ціни в поясненні)."""

PriceStatsLookup = Callable[[FlightQuery, Decimal], Awaitable[PriceStats | None]]
Clock = Callable[[], datetime]


class ChannelStatus(BaseModel):
    telegram: Literal["live", "mock"]
    email: Literal["live", "mock"]
    bot_username: str | None


class AlertCreated(BaseModel):
    id: str
    status: str
    channel: AlertChannel
    manage_token: str
    """Секрет для сторінки керування — показується один раз, далі лише в посиланнях."""
    telegram_link: str | None = None
    """t.me/<бот>?start=<код> — відкрити, щоб підтвердити підписку."""


class AlertError(ValueError):
    """Підписку не створити (минула дата, канал недоступний) — для API це 422."""


@dataclass(frozen=True)
class AlertSettings:
    public_web_url: str
    bot_username: str | None
    min_hours_between_notifications: int


class AlertService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        search: FlightSearchService,
        telegram: TelegramClient,
        mailer: Mailer,
        settings: AlertSettings,
        redis: Redis | None = None,
        price_stats: PriceStatsLookup | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._search = search
        self._telegram = telegram
        self._mailer = mailer
        self._settings = settings
        self._redis = redis
        self._price_stats = price_stats
        self._clock = clock or (lambda: datetime.now(UTC))

    def channels(self) -> ChannelStatus:
        return ChannelStatus(
            telegram="mock" if self._telegram.name == "mock" else "live",
            email="mock" if self._mailer.name == "mock" else "live",
            bot_username=self._settings.bot_username,
        )

    # --- підписка ---------------------------------------------------------------------

    async def create(self, body: AlertCreate) -> AlertCreated:
        if body.departure_date < self._clock().date():
            raise AlertError("дата вильоту вже минула")
        token = secrets.token_urlsafe(24)  # 32 символи [A-Za-z0-9_-]: годиться для /start
        alert = Alert(
            id=uuid.uuid4().hex,
            token=token,
            origin=body.origin,
            destination=body.destination,
            departure_date=body.departure_date,
            return_date=body.return_date,
            adults=body.adults,
            condition=body.condition,
            threshold=body.threshold,
            currency=body.currency,
            channel=body.channel,
            email=body.email,
            status="pending",
        )
        async with self._sessionmaker() as session, session.begin():
            session.add(alert)
            session.add(AlertEvent(alert_id=alert.id, kind="created"))
        link = None
        if body.channel == "telegram":
            bot = self._settings.bot_username or "your_bot"
            link = f"https://t.me/{bot}?start={token}"
        elif body.email is not None:
            await self._send_mail(
                body.email,
                "Підтвердіть підписку на ціну",
                confirm_email_text(alert, self._manage_url(token)),
            )
        return AlertCreated(
            id=alert.id,
            status="pending",
            channel=body.channel,
            manage_token=token,
            telegram_link=link,
        )

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

    async def stop(self, token: str) -> AlertView | None:
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            if alert is None:
                return None
            if alert.status in ("pending", "active"):
                alert.status = "stopped"
                session.add(AlertEvent(alert_id=alert.id, kind="stopped"))
            return _view(alert)

    # --- бот --------------------------------------------------------------------------

    async def poll_telegram(self) -> int:
        """Одне опитування getUpdates; зсув зберігається в Redis. Повертає к-сть оновлень."""
        offset = await self._read_offset()
        try:
            updates = await self._telegram.get_updates(offset)
        except TelegramError as exc:
            log.warning("alerts.telegram_poll_failed", error=str(exc))
            return 0
        for update in updates:
            try:
                await self.handle_telegram_update(update)
            except Exception:  # одне биті оновлення не зупиняє решту
                log.exception("alerts.telegram_update_failed")
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                offset = max(offset or 0, update_id + 1)
        if updates:
            await self._write_offset(offset)
        return len(updates)

    async def handle_telegram_update(self, update: dict[str, Any]) -> None:
        message = update.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat") or {}
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        text = str(message.get("text") or "").strip()
        if not isinstance(chat_id, int) or not text.startswith("/"):
            if isinstance(chat_id, int):
                await self._reply(chat_id, HELP_TEXT)
            return
        command, _, argument = text.partition(" ")
        command = command.split("@", 1)[0]  # /start@bot у групах
        if command == "/start" and argument:
            await self._bind_telegram(chat_id, argument.strip())
        elif command == "/list":
            await self._list_for_chat(chat_id)
        elif command == "/stop":
            await self._stop_chat(chat_id)
        else:
            await self._reply(chat_id, HELP_TEXT)

    async def _bind_telegram(self, chat_id: int, token: str) -> None:
        async with self._sessionmaker() as session, session.begin():
            alert = await _by_token(session, token)
            bound = alert is not None and alert.channel == "telegram" and alert.status == "pending"
            if alert is not None and bound:
                alert.telegram_chat_id = chat_id
                alert.status = "active"
                alert.confirmed_at = self._clock()
                session.add(AlertEvent(alert_id=alert.id, kind="confirmed"))
                text, manage = confirmed_text(alert), self._manage_url(alert.token)
        if bound and alert is not None:
            await self._reply(chat_id, text, [("Керувати підпискою", manage)])
            await self._first_check(alert.id)
        else:
            await self._reply(chat_id, UNKNOWN_LINK_TEXT)

    async def _list_for_chat(self, chat_id: int) -> None:
        async with self._sessionmaker() as session:
            alerts = (
                await session.scalars(
                    select(Alert).where(Alert.telegram_chat_id == chat_id, Alert.status == "active")
                )
            ).all()
        if not alerts:
            await self._reply(chat_id, "Активних підписок немає.")
            return
        lines = [f"• {route_text(a)} — {condition_text(a)}" for a in alerts]
        await self._reply(chat_id, "Ваші підписки:\n" + "\n".join(lines))

    async def _stop_chat(self, chat_id: int) -> None:
        async with self._sessionmaker() as session, session.begin():
            alerts = (
                await session.scalars(
                    select(Alert).where(Alert.telegram_chat_id == chat_id, Alert.status == "active")
                )
            ).all()
            for alert in alerts:
                alert.status = "stopped"
                session.add(AlertEvent(alert_id=alert.id, kind="stopped"))
        await self._reply(chat_id, f"Готово: вимкнено підписок — {len(alerts)}.")

    # --- перевірка цін ----------------------------------------------------------------

    async def check_all(self) -> int:
        """Перевірити всі активні підписки. Повертає к-сть надісланих сповіщень."""
        async with self._sessionmaker() as session:
            ids = (await session.scalars(select(Alert.id).where(Alert.status == "active"))).all()
        sent = 0
        for alert_id in ids:
            try:
                sent += await self.check(alert_id)
            except Exception:  # одна підписка не зупиняє решту
                log.exception("alerts.check_failed", alert_id=alert_id)
        return sent

    async def check(self, alert_id: str) -> int:
        now = self._clock()
        async with self._sessionmaker() as session:
            alert = await session.get(Alert, alert_id)
            if alert is None or alert.status != "active":
                return 0
            if alert.departure_date < now.date():
                alert.status = "expired"
                session.add(AlertEvent(alert_id=alert.id, kind="expired"))
                await session.commit()
                return 0
            query = FlightQuery(
                origin=alert.origin,
                destination=alert.destination,
                departure_date=alert.departure_date,
                return_date=alert.return_date,
                passengers={"adults": alert.adults},
                currency=alert.currency,
            )
            result = await self._search.search(query)
            prices = [o.price for o in result.offers if o.currency == alert.currency]
            best = min(prices) if prices else None
            alert.last_checked_at = now
            alert.last_price = best
            session.add(AlertEvent(alert_id=alert.id, kind="checked", price=best))
            reason = await self._reason(alert, query, best)
            notify = reason is not None and best is not None and self._may_notify(alert, best, now)
            await session.commit()
            if not notify or best is None or reason is None:
                return 0
            delivered = await self._notify(alert, best, reason, query)
            if delivered:
                alert.last_notified_price = best
                alert.last_notified_at = now
                session.add(AlertEvent(alert_id=alert.id, kind="notified", price=best))
                await session.commit()
            return int(delivered)

    async def _reason(self, alert: Alert, query: FlightQuery, best: Decimal | None) -> str | None:
        """Чому сповіщаємо (текст для повідомлення) або None, якщо умова не виконана."""
        if best is None:
            return None
        if alert.condition == "below_price" and alert.threshold is not None:
            if best <= alert.threshold:
                return f"нижче вашого порогу {money_text(Decimal(alert.threshold), alert.currency)}"
            return None
        if alert.condition == "below_typical" and self._price_stats is not None:
            stats = await self._price_stats(query, best)
            if stats is None or stats.sample_size < MIN_TYPICAL_SAMPLE:
                return None
            limit = stats.median * (Decimal(100 - TYPICAL_DISCOUNT_PERCENT) / 100)
            if best <= limit:
                return f"нижче типової для маршруту ціни {money_text(stats.median, alert.currency)}"
        return None

    def _may_notify(self, alert: Alert, best: Decimal, now: datetime) -> bool:
        if alert.last_notified_price is not None and best >= alert.last_notified_price:
            return False
        if alert.last_notified_at is None:
            return True
        pause = timedelta(hours=self._settings.min_hours_between_notifications)
        return now - _aware(alert.last_notified_at) >= pause

    async def _notify(self, alert: Alert, best: Decimal, reason: str, query: FlightQuery) -> bool:
        search_url = f"{self._settings.public_web_url}/?{_search_params(query)}"
        manage_url = self._manage_url(alert.token)
        text = price_drop_text(alert, best, reason, search_url, manage_url)
        if alert.channel == "telegram" and alert.telegram_chat_id is not None:
            buttons = [("Переглянути квитки", search_url), ("Керувати підпискою", manage_url)]
            return await self._reply(alert.telegram_chat_id, text, buttons)
        if alert.channel == "email" and alert.email:
            return await self._send_mail(alert.email, f"Ціна знизилась: {route_text(alert)}", text)
        return False

    # --- внутрішнє --------------------------------------------------------------------

    async def _first_check(self, alert_id: str) -> None:
        """Одразу після підтвердження — перша перевірка: якщо ціна вже нижча за поріг,
        людина дізнається зараз, а не за кілька годин до наступної планової перевірки."""
        try:
            await self.check(alert_id)
        except Exception:  # підтвердження вже відбулося — перевірка повториться за розкладом
            log.exception("alerts.first_check_failed", alert_id=alert_id)

    def _manage_url(self, token: str) -> str:
        return f"{self._settings.public_web_url}/alerts?token={token}"

    async def _reply(
        self, chat_id: int, text: str, buttons: list[tuple[str, str]] | None = None
    ) -> bool:
        try:
            await self._telegram.send_message(chat_id, text, buttons or [])
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

    async def _read_offset(self) -> int | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(TELEGRAM_OFFSET_KEY)
        except RedisError:
            return None
        return int(raw) if raw else None

    async def _write_offset(self, offset: int | None) -> None:
        if self._redis is None or offset is None:
            return
        try:
            await self._redis.set(TELEGRAM_OFFSET_KEY, offset)
        except RedisError as exc:
            log.warning("alerts.offset_write_failed", error=type(exc).__name__)


async def _by_token(session: AsyncSession, token: str) -> Alert | None:
    if not token or len(token) > 64:
        return None
    return await session.scalar(select(Alert).where(Alert.token == token))


def _view(alert: Alert) -> AlertView:
    return AlertView.model_validate(alert, from_attributes=True)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _search_params(query: FlightQuery) -> str:
    params = f"from={query.origin}&to={query.destination}&depart={query.departure_date}"
    if query.return_date:
        params += f"&return={query.return_date}"
    if query.passengers.adults > 1:
        params += f"&adults={query.passengers.adults}"
    return params


# --- тексти повідомлень (українською) -----------------------------------------------

HELP_TEXT = (
    "Я надсилаю сповіщення, коли ціна на квитки знижується.\n"
    "Підписатися можна на сайті: кнопка «Стежити за ціною» на сторінці результатів.\n\n"
    "/list — ваші підписки\n/stop — вимкнути всі підписки"
)
UNKNOWN_LINK_TEXT = "Посилання застаріле або вже використане. Створіть підписку ще раз на сайті."


def _date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def route_text(alert: Alert) -> str:
    dates = _date(alert.departure_date)
    if alert.return_date:
        dates += f" – {_date(alert.return_date)}"
    return f"{alert.origin} → {alert.destination}, {dates}"


def condition_text(alert: Alert) -> str:
    if alert.condition == "below_price" and alert.threshold is not None:
        return f"ціна до {money_text(Decimal(alert.threshold), alert.currency)} за дорослого"
    return f"ціна на {TYPICAL_DISCOUNT_PERCENT}% нижча за типову"


def confirmed_text(alert: Alert) -> str:
    return (
        f"Підписку підтверджено ✅\n{route_text(alert)}\nУмова: {condition_text(alert)}.\n\n"
        "Напишу, щойно ціна опуститься. /stop — вимкнути."
    )


def confirm_email_text(alert: Alert, manage_url: str) -> str:
    return (
        "Ви (чи хтось від вашого імені) підписалися на сповіщення про ціну:\n"
        f"{route_text(alert)}\nУмова: {condition_text(alert)}.\n\n"
        f"Щоб підтвердити, відкрийте посилання й натисніть «Підтвердити»:\n{manage_url}\n\n"
        "Якщо це були не ви — просто проігноруйте лист: без підтвердження листів не буде."
    )


def price_drop_text(
    alert: Alert, best: Decimal, reason: str, search_url: str, manage_url: str
) -> str:
    return (
        f"✈️ Ціна знизилась: {route_text(alert)}\n"
        f"Зараз від {money_text(best, alert.currency)} за дорослого — {reason}.\n"
        "Це кешована ціна з історії пошуків: остаточну підтверджує продавець.\n\n"
        f"Квитки: {search_url}\nКерувати підпискою: {manage_url}"
    )
