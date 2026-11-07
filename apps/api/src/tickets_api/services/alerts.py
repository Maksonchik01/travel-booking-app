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

import secrets
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal

import structlog
from pydantic import BaseModel
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
from tickets_api.notifications.telegram import Button, Keyboard, TelegramClient, TelegramError, esc
from tickets_api.repositories.price_history import PriceStats
from tickets_api.services.flight_search import FlightSearchService

log = structlog.get_logger(__name__)

MIN_TYPICAL_SAMPLE = 20
"""«Нижче типової» має сенс лише з достатньою історією (як і оцінка ціни в поясненні)."""
SNOOZE_DAYS = 7

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
        price_stats: PriceStatsLookup | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._search = search
        self._telegram = telegram
        self._mailer = mailer
        self._settings = settings
        self._price_stats = price_stats
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
        )

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
            raise AlertError("дата вильоту вже минула")
        token = secrets.token_urlsafe(24)  # 32 символи [A-Za-z0-9_-]: годиться для /start
        active = chat_id is not None
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
            telegram_chat_id=chat_id,
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
            await self._send_mail(
                body.email,
                "Підтвердіть підписку на ціну",
                confirm_email_text(alert, self.manage_url(token)),
            )
        return AlertCreated(
            id=alert.id,
            status=alert.status,
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
            query = flight_query(alert)
            result = await self._search.search(query)
            prices = [o.price for o in result.offers if o.currency == alert.currency]
            best = min(prices) if prices else None
            alert.last_checked_at = now
            alert.last_price = best
            session.add(AlertEvent(alert_id=alert.id, kind="checked", price=best))
            reason = await self._reason(alert, query, best)
            snoozed = alert.snoozed_until is not None and now.date() < alert.snoozed_until
            notify = (
                reason is not None
                and best is not None
                and not snoozed
                and self._may_notify(alert, best, now)
            )
            previous = alert.last_notified_price
            await session.commit()
            if not notify or best is None or reason is None:
                return 0
            delivered = await self._notify(alert, best, reason, previous)
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

    async def _notify(
        self, alert: Alert, best: Decimal, reason: str, previous: Decimal | None
    ) -> bool:
        search_url = self.search_url(alert)
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
            return await self._send_mail(alert.email, f"Ціна знизилась: {route_text(alert)}", text)
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

    def search_url(self, alert: Alert) -> str:
        params = f"from={alert.origin}&to={alert.destination}&depart={alert.departure_date}"
        if alert.return_date:
            params += f"&return={alert.return_date}"
        if alert.adults > 1:
            params += f"&adults={alert.adults}"
        return f"{self._settings.public_web_url}/?{params}"

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
    return FlightQuery(
        origin=alert.origin,
        destination=alert.destination,
        departure_date=alert.departure_date,
        return_date=alert.return_date,
        passengers={"adults": alert.adults},
        currency=alert.currency,
    )


def _stop(session: AsyncSession, alert: Alert) -> None:
    if alert.status in ("pending", "active"):
        alert.status = "stopped"
        session.add(AlertEvent(alert_id=alert.id, kind="stopped"))


async def _by_token(session: AsyncSession, token: str) -> Alert | None:
    if not token or len(token) > 64:
        return None
    return await session.scalar(select(Alert).where(Alert.token == token))


def _view(alert: Alert) -> AlertView:
    return AlertView.model_validate(alert, from_attributes=True)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


# --- тексти повідомлень (українською) -----------------------------------------------


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


def alert_keyboard(
    alert: Alert, search_url: str, manage_url: str, *, snooze: bool = False
) -> list[list[Button]]:
    """Кнопки під повідомленням про підписку. Посилання — лише якщо сайт на https."""
    actions = [Button("⏸ Вимкнути", data=f"stop:{alert.id}")]
    if snooze:
        actions.append(Button(f"😴 Тиша {SNOOZE_DAYS} днів", data=f"snooze:{alert.id}"))
    else:
        actions.append(Button("✏️ Змінити поріг", data=f"thr:{alert.id}"))
    return [
        [Button("✈️ Квитки", url=search_url), Button("⚙️ Керувати", url=manage_url)],
        actions,
    ]


def links_html(search_url: str, manage_url: str) -> str:
    """Поки сайт не на https, кнопки-посилання Telegram не приймає — даємо посилання текстом."""
    if search_url.startswith("https://"):
        return ""
    return f"\n\nКвитки: {esc(search_url)}\nКерувати: {esc(manage_url)}"


def price_drop_html(
    alert: Alert,
    best: Decimal,
    reason: str,
    previous: Decimal | None,
    search_url: str,
    manage_url: str,
) -> str:
    lines = [
        "✈️ <b>Ціна знизилась</b>",
        f"<b>{esc(route_text(alert))}</b>",
        "",
        f"Зараз від <b>{esc(money_text(best, alert.currency))}</b> за дорослого — {esc(reason)}.",
    ]
    if previous is not None and previous > best:
        lines.append(
            f"Минулого разу писали про {esc(money_text(previous, alert.currency))}: "
            f"ще на {esc(money_text(previous - best, alert.currency))} дешевше."
        )
    lines.append("<i>Ціна з історії пошуків: остаточну підтверджує продавець.</i>")
    return "\n".join(lines) + links_html(search_url, manage_url)


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
