"""Telegram-бот @<TELEGRAM_BOT_USERNAME>: команди, кнопки й діалог нової підписки (ADR 0010).

Що вміє:
- /start <код> — підтвердити підписку з сайту; /start link_<код> — прив'язати чат до акаунта;
- /new — нова підписка прямо в чаті: звідки → куди → дата → повернення → поріг (з кнопками);
- /list — активні підписки з кнопками «Вимкнути» й «Змінити поріг»; /stop — вимкнути всі;
- під сповіщенням — «Вимкнути» й «Тиша 7 днів»; /link — як прив'язати акаунт; /help.

Стан діалогу — у Redis (година), без БД. Кнопки (callback_data) діють лише на підписки
цього ж чату. Тексти з чату — НЕДОВІРЕНІ дані: лише розбираємо, ніколи не виконуємо.
"""

import contextlib
import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.ai.explainer import money_text
from tickets_api.db.models import Alert, AuthToken, User
from tickets_api.domain.alerts import AlertCreate
from tickets_api.notifications.telegram import Button, TelegramError, esc
from tickets_api.reference.airports import AirportDirectory
from tickets_api.services.accounts import token_hash
from tickets_api.services.alerts import (
    AlertError,
    AlertService,
    alert_keyboard,
    condition_text,
    links_html,
    party_text,
    route_text,
)

log = structlog.get_logger(__name__)

OFFSET_KEY = "alerts:telegram:offset"
DIALOG_TTL_S = 60 * 60
MAX_DAYS_AHEAD = 330
LINK_PREFIX = "link_"
COMMANDS: tuple[tuple[str, str], ...] = (
    ("new", "Нова підписка на ціну"),
    ("list", "Мої підписки"),
    ("link", "Прив'язати до акаунта на сайті"),
    ("stop", "Вимкнути всі підписки"),
    ("cancel", "Скасувати поточну дію"),
    ("help", "Що вміє бот"),
)


@dataclass
class Dialog:
    step: str
    """origin → destination → departure → return → threshold; або edit_threshold."""
    origin: str | None = None
    destination: str | None = None
    departure: str | None = None
    return_date: str | None = None
    alert_id: str | None = None


class TelegramBotService:
    def __init__(
        self,
        alerts: AlertService,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        redis: Redis | None,
        airports: AirportDirectory,
    ) -> None:
        self._alerts = alerts
        self._telegram = alerts.telegram
        self._sessionmaker = sessionmaker
        self._redis = redis
        self._airports = airports

    async def setup(self) -> None:
        """Меню команд (кнопка «/» у Telegram). Збій — не критичний."""
        try:
            await self._telegram.set_commands(COMMANDS)
        except TelegramError as exc:
            log.warning("bot.set_commands_failed", error=str(exc))

    async def poll(self) -> int:
        """Одне опитування getUpdates; зсув — у Redis. Повертає к-сть оновлень."""
        offset = await self._get_int(OFFSET_KEY)
        try:
            updates = await self._telegram.get_updates(offset)
        except TelegramError as exc:
            log.warning("bot.poll_failed", error=str(exc))
            return 0
        for update_ in updates:
            try:
                await self.handle(update_)
            except Exception:  # одне биті оновлення не зупиняє решту
                log.exception("bot.update_failed")
            update_id = update_.get("update_id")
            if isinstance(update_id, int):
                offset = max(offset or 0, update_id + 1)
        if updates and offset is not None and self._redis is not None:
            with contextlib.suppress(RedisError):
                await self._redis.set(OFFSET_KEY, offset)
        return len(updates)

    async def handle(self, update_: dict[str, Any]) -> None:
        callback = update_.get("callback_query")
        if isinstance(callback, dict):
            await self._callback(callback)
            return
        message = update_.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat") or {}
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        if not isinstance(chat_id, int):
            return
        text = str(message.get("text") or "").strip()[:200]
        if text.startswith("/"):
            await self._command(chat_id, text)
            return
        dialog = await self._dialog(chat_id)
        if dialog is not None:
            await self._answer(chat_id, dialog, text)
        else:
            await self._send(chat_id, HELP_HTML, [[Button("➕ Нова підписка", data="new")]])

    # --- команди ----------------------------------------------------------------------

    async def _command(self, chat_id: int, text: str) -> None:
        command, _, argument = text.partition(" ")
        command = command.split("@", 1)[0].lower()  # /start@bot у групах
        argument = argument.strip()
        if command == "/start" and argument.startswith(LINK_PREFIX):
            await self._link_account(chat_id, argument.removeprefix(LINK_PREFIX))
        elif command == "/start" and argument:
            await self._confirm_site_alert(chat_id, argument)
        elif command == "/start":
            await self._send(chat_id, WELCOME_HTML, MAIN_MENU)
        elif command == "/new":
            await self._start_new(chat_id)
        elif command == "/list":
            await self._list(chat_id)
        elif command == "/stop":
            stopped = await self._alerts.stop_for_chat(chat_id)
            await self._clear_dialog(chat_id)
            await self._send(chat_id, f"Готово: вимкнено підписок — {stopped}.")
        elif command == "/cancel":
            await self._clear_dialog(chat_id)
            await self._send(chat_id, "Скасовано.", MAIN_MENU)
        elif command == "/link":
            await self._send(chat_id, LINK_HELP_HTML)
        else:
            await self._send(chat_id, HELP_HTML, MAIN_MENU)

    async def _confirm_site_alert(self, chat_id: int, token: str) -> None:
        alert = await self._alerts.bind_telegram(token, chat_id)
        if alert is None:
            await self._send(chat_id, UNKNOWN_LINK_TEXT, MAIN_MENU)
            return
        await self._attach_owner(chat_id, alert.id)
        await self._send(
            chat_id,
            f"✅ <b>Підписку підтверджено</b>\n{esc(route_text(alert))}\n"
            f"Умова: {esc(condition_text(alert))}.\n\nНапишу, щойно ціна опуститься.",
            self._keyboard(alert),
        )
        await self._alerts.check(alert.id)  # перша перевірка — одразу

    async def _list(self, chat_id: int) -> None:
        alerts = await self._alerts.chat_alerts(chat_id)
        if not alerts:
            await self._send(
                chat_id, "Активних підписок немає.", [[Button("➕ Нова підписка", data="new")]]
            )
            return
        lines = ["<b>Ваші підписки</b>"]
        rows: list[list[Button]] = []
        for i, a in enumerate(alerts[:10], start=1):
            price = f" · зараз від {esc(_money(a.last_price, a.currency))}" if a.last_price else ""
            lines.append(f"{i}. {esc(route_text(a))} — {esc(condition_text(a))}{price}")
            rows.append(
                [
                    Button(f"⏸ {i}. Вимкнути", data=f"stop:{a.id}"),
                    Button("✏️ Поріг", data=f"thr:{a.id}"),
                ]
            )
        rows.append([Button("➕ Нова підписка", data="new")])
        await self._send(chat_id, "\n".join(lines), rows)

    async def _link_account(self, chat_id: int, token: str) -> None:
        """/start link_<код> з кабінету: цей чат стає Telegram-ом акаунта."""
        async with self._sessionmaker() as session, session.begin():
            row = await session.get(AuthToken, token_hash(token))
            valid = (
                row is not None
                and row.purpose == "telegram_link"
                and row.used_at is None
                and row.expires_at > self._alerts.now()
            )
            if not valid or row is None:
                user = None
            else:
                row.used_at = self._alerts.now()
                # Чат міг бути прив'язаний до іншого акаунта — переносимо.
                await session.execute(
                    update(User)
                    .where(User.telegram_chat_id == chat_id)
                    .values(telegram_chat_id=None)
                )
                user = await session.get(User, row.user_id)
                if user is not None:
                    user.telegram_chat_id = chat_id
                    await session.execute(
                        update(Alert)
                        .where(Alert.telegram_chat_id == chat_id, Alert.user_id.is_(None))
                        .values(user_id=user.id)
                    )
        if user is None:
            await self._send(chat_id, UNKNOWN_LINK_TEXT, MAIN_MENU)
            return
        await self._send(
            chat_id,
            f"🔗 Telegram прив'язано до акаунта <b>@{esc(user.username)}</b>.\n"
            "Підписки з цього чату тепер видно в кабінеті на сайті.",
            MAIN_MENU,
        )

    # --- кнопки -----------------------------------------------------------------------

    async def _callback(self, callback: dict[str, Any]) -> None:
        callback_id = str(callback.get("id") or "")
        data = str(callback.get("data") or "")
        message = callback.get("message") or {}
        chat = message.get("chat") if isinstance(message, dict) else None
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        if not isinstance(chat_id, int):
            await self._ack(callback_id)
            return
        action, _, value = data.partition(":")
        if action == "new":
            await self._ack(callback_id)
            await self._start_new(chat_id)
        elif action == "list":
            await self._ack(callback_id)
            await self._list(chat_id)
        elif action == "stop":
            stopped = await self._alerts.stop_for_chat(chat_id, value)
            await self._ack(callback_id, "Підписку вимкнено" if stopped else "Уже вимкнена")
            if stopped:
                await self._send(
                    chat_id, "⏸ Підписку вимкнено.", [[Button("📋 Мої підписки", data="list")]]
                )
        elif action == "snooze":
            until = await self._alerts.snooze_for_chat(chat_id, value)
            await self._ack(
                callback_id, f"Тиша до {until:%d.%m}" if until else "Підписка неактивна"
            )
        elif action == "thr":
            alert = await self._alerts.chat_alert(chat_id, value)
            await self._ack(callback_id)
            if alert is None or alert.status != "active":
                await self._send(chat_id, "Ця підписка вже неактивна.")
                return
            await self._save_dialog(chat_id, Dialog(step="edit_threshold", alert_id=alert.id))
            await self._send(
                chat_id,
                f"Новий поріг для {esc(route_text(alert))} — ціна {party_text(alert)} в "
                f"{esc(alert.currency)}, наприклад <code>90</code>.",
                [[Button("📉 Нижче типової", data="typ"), Button("✖️ Скасувати", data="cancel")]],
            )
        elif action == "pick":
            field, _, code = value.partition(":")
            await self._ack(callback_id)
            dialog = await self._dialog(chat_id)
            if dialog is not None and dialog.step == field and self._airports.knows(code):
                await self._place_chosen(chat_id, dialog, code.upper())
        elif action == "ow":
            await self._ack(callback_id)
            dialog = await self._dialog(chat_id)
            if dialog is not None and dialog.step == "return":
                dialog.step = "threshold"
                await self._save_dialog(chat_id, dialog)
                await self._ask_threshold(chat_id)
        elif action == "typ":
            await self._ack(callback_id)
            dialog = await self._dialog(chat_id)
            if dialog is not None and dialog.step in ("threshold", "edit_threshold"):
                await self._finish(chat_id, dialog, None)
        elif action == "cancel":
            await self._ack(callback_id, "Скасовано")
            await self._clear_dialog(chat_id)
        else:
            await self._ack(callback_id)

    # --- діалог нової підписки --------------------------------------------------------

    async def _start_new(self, chat_id: int) -> None:
        await self._save_dialog(chat_id, Dialog(step="origin"))
        await self._send(
            chat_id,
            "➕ <b>Нова підписка</b>\nЗвідки летимо? Напишіть місто чи код аеропорту, "
            "наприклад <code>Варшава</code> або <code>WAW</code>.",
            CANCEL,
        )

    async def _answer(self, chat_id: int, dialog: Dialog, text: str) -> None:
        if dialog.step in ("origin", "destination"):
            await self._place(chat_id, dialog, text)
        elif dialog.step == "departure":
            day = parse_date(text, self._alerts.now().date())
            if day is None or not self._in_range(day):
                await self._send(chat_id, BAD_DATE_TEXT, CANCEL)
                return
            dialog.departure = day.isoformat()
            dialog.step = "return"
            await self._save_dialog(chat_id, dialog)
            await self._send(
                chat_id,
                "Дата повернення? Або натисніть «В один бік».",
                [[Button("➡️ В один бік", data="ow"), Button("✖️ Скасувати", data="cancel")]],
            )
        elif dialog.step == "return":
            day = parse_date(text, self._alerts.now().date())
            departure = date.fromisoformat(dialog.departure or "")
            if day is None or day < departure or not self._in_range(day):
                await self._send(chat_id, "Повернення має бути не раніше вильоту. " + BAD_DATE_TEXT)
                return
            dialog.return_date = day.isoformat()
            dialog.step = "threshold"
            await self._save_dialog(chat_id, dialog)
            await self._ask_threshold(chat_id)
        elif dialog.step in ("threshold", "edit_threshold"):
            amount = parse_amount(text)
            if amount is None:
                await self._send(
                    chat_id,
                    "Напишіть суму числом, наприклад <code>120</code>, "
                    "або натисніть «Нижче типової».",
                    [
                        [
                            Button("📉 Нижче типової", data="typ"),
                            Button("✖️ Скасувати", data="cancel"),
                        ]
                    ],
                )
                return
            await self._finish(chat_id, dialog, amount)

    async def _place(self, chat_id: int, dialog: Dialog, text: str) -> None:
        places = self._airports.search(text, limit=4, lang="uk") if len(text) >= 2 else []
        if not places:
            await self._send(
                chat_id,
                f"Не знайшов «{esc(text[:40])}». Спробуйте назву міста українською чи англійською "
                "або код аеропорту з трьох літер.",
                CANCEL,
            )
            return
        exact = next((p for p in places if p.code == text.strip().upper()), None)
        if exact is not None or len(places) == 1:
            await self._place_chosen(chat_id, dialog, (exact or places[0]).code)
            return
        rows = [
            [
                Button(
                    f"{p.city_name}{'' if p.kind == 'city' else ', ' + p.name} · {p.code}",
                    data=f"pick:{dialog.step}:{p.code}",
                )
            ]
            for p in places
        ]
        rows.append([Button("✖️ Скасувати", data="cancel")])
        await self._send(chat_id, "Уточніть, будь ласка:", rows)

    async def _place_chosen(self, chat_id: int, dialog: Dialog, code: str) -> None:
        if dialog.step == "origin":
            dialog.origin = code
            dialog.step = "destination"
            await self._save_dialog(chat_id, dialog)
            await self._send(chat_id, f"Звідки: <b>{esc(code)}</b>. Куди летимо?", CANCEL)
            return
        if code == dialog.origin:
            await self._send(chat_id, "Місто призначення має відрізнятися. Куди летимо?", CANCEL)
            return
        dialog.destination = code
        dialog.step = "departure"
        await self._save_dialog(chat_id, dialog)
        await self._send(
            chat_id,
            f"<b>{esc(dialog.origin)} → {esc(code)}</b>. Дата вильоту? Наприклад "
            "<code>05.12</code> або <code>2026-12-05</code>.",
            CANCEL,
        )

    async def _ask_threshold(self, chat_id: int) -> None:
        await self._send(
            chat_id,
            "Коли повідомити? Напишіть поріг ціни за дорослого в EUR (наприклад <code>120</code>) "
            "або оберіть «Нижче типової» — коли ціна на 10% нижча за звичну для маршруту.",
            [[Button("📉 Нижче типової", data="typ"), Button("✖️ Скасувати", data="cancel")]],
        )

    async def _finish(self, chat_id: int, dialog: Dialog, amount: int | None) -> None:
        await self._clear_dialog(chat_id)
        if dialog.step == "edit_threshold" and dialog.alert_id:
            if amount is None:
                await self._send(
                    chat_id, "Для зміни поведінки на «нижче типової» створіть нову підписку: /new"
                )
                return
            ok = await self._alerts.set_threshold_for_chat(chat_id, dialog.alert_id, amount)
            await self._send(
                chat_id,
                f"✏️ Новий поріг: <b>{amount} EUR</b>." if ok else "Ця підписка вже неактивна.",
            )
            return
        try:
            body = AlertCreate(
                origin=dialog.origin or "",
                destination=dialog.destination or "",
                departure_date=date.fromisoformat(dialog.departure or ""),
                return_date=date.fromisoformat(dialog.return_date) if dialog.return_date else None,
                condition="below_price" if amount is not None else "below_typical",
                threshold=amount,
                channel="telegram",
            )
            created = await self._alerts.create(body, await self._owner(chat_id), chat_id=chat_id)
        except (AlertError, ValueError) as exc:
            log.info("bot.new_alert_rejected", error=type(exc).__name__)
            await self._send(chat_id, "Не вдалося створити підписку. Спробуйте ще раз: /new")
            return
        alert = await self._alerts.chat_alert(chat_id, created.id)
        if alert is None:
            return
        price = (
            f"\nЗараз від <b>{esc(_money(alert.last_price, alert.currency))}</b> "
            f"{party_text(alert)}."
            if alert.last_price is not None
            else "\nЦін на ці дати в історії пошуків поки немає — "
            "перевірятиму кілька разів на добу."
        )
        await self._send(
            chat_id,
            f"✅ <b>Стежу за ціною</b>\n{esc(route_text(alert))}\n"
            f"Умова: {esc(condition_text(alert))}.{price}",
            self._keyboard(alert),
        )

    # --- внутрішнє --------------------------------------------------------------------

    def _keyboard(self, alert: Alert) -> list[list[Button]]:
        return alert_keyboard(
            alert, self._alerts.search_url(alert), self._alerts.manage_url(alert.token)
        )

    def _in_range(self, day: date) -> bool:
        today = self._alerts.now().date()
        return today <= day <= today + timedelta(days=MAX_DAYS_AHEAD)

    async def _owner(self, chat_id: int) -> str | None:
        async with self._sessionmaker() as session:
            return await session.scalar(select(User.id).where(User.telegram_chat_id == chat_id))

    async def _attach_owner(self, chat_id: int, alert_id: str) -> None:
        owner = await self._owner(chat_id)
        if owner is None:
            return
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                update(Alert)
                .where(Alert.id == alert_id, Alert.user_id.is_(None))
                .values(user_id=owner)
            )

    async def _send(
        self, chat_id: int, text: str, keyboard: list[list[Button]] | None = None
    ) -> None:
        links = ""
        if keyboard and any(
            b.url and not b.url.startswith("https://") for r in keyboard for b in r
        ):
            urls = [b.url for r in keyboard for b in r if b.url]
            links = links_html(urls[0], urls[-1]) if len(urls) >= 2 else ""
        await self._alerts.reply(chat_id, text + links, keyboard or [], html=True)

    async def _ack(self, callback_id: str, text: str | None = None) -> None:
        if not callback_id:
            return
        try:
            await self._telegram.answer_callback(callback_id, text)
        except TelegramError as exc:
            log.warning("bot.answer_callback_failed", error=str(exc))

    async def _dialog(self, chat_id: int) -> Dialog | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(f"bot:dlg:{chat_id}")
        except RedisError:
            return None
        return Dialog(**json.loads(raw)) if raw else None

    async def _save_dialog(self, chat_id: int, dialog: Dialog) -> None:
        if self._redis is None:
            return
        with contextlib.suppress(RedisError):
            await self._redis.set(
                f"bot:dlg:{chat_id}", json.dumps(dialog.__dict__), ex=DIALOG_TTL_S
            )

    async def _clear_dialog(self, chat_id: int) -> None:
        if self._redis is None:
            return
        with contextlib.suppress(RedisError):
            await self._redis.delete(f"bot:dlg:{chat_id}")

    async def _get_int(self, key: str) -> int | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(key)
        except RedisError:
            return None
        return int(raw) if raw else None


def parse_date(text: str, today: date) -> date | None:
    """«2026-12-05», «05.12.2026», «5.12» (найближча така дата в майбутньому)."""
    text = text.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return date.fromisoformat(text)
        if m := re.fullmatch(r"(\d{1,2})[./](\d{1,2})[./](\d{4})", text):
            return date(int(m[3]), int(m[2]), int(m[1]))
        if m := re.fullmatch(r"(\d{1,2})[./](\d{1,2})", text):
            candidate = date(today.year, int(m[2]), int(m[1]))
            return candidate if candidate >= today else date(today.year + 1, int(m[2]), int(m[1]))
    except ValueError:
        return None
    return None


def parse_amount(text: str) -> int | None:
    """«120», «120 €», «до 99.5» → ціле (вниз). Від 1 до 100 000."""
    m = re.search(r"\d+(?:[.,]\d+)?", text)
    if m is None:
        return None
    value = int(float(m[0].replace(",", ".")))
    return value if 1 <= value <= 100_000 else None


def _money(value: Decimal | None, currency: str) -> str:
    return money_text(value or Decimal(0), currency)


MAIN_MENU = [[Button("➕ Нова підписка", data="new"), Button("📋 Мої підписки", data="list")]]
CANCEL = [[Button("✖️ Скасувати", data="cancel")]]
WELCOME_HTML = (
    "👋 <b>Привіт! Я бот SkyPack.</b>\n"
    "Стежу за цінами на авіаквитки й пишу, щойно ціна опускається нижче вашого порогу "
    "або нижче звичної для маршруту.\n\n"
    "• /new — нова підписка (звідки, куди, дата, поріг)\n"
    "• /list — ваші підписки\n"
    "• /link — прив'язати до акаунта на сайті\n\n"
    "Підписатися можна й на сайті: кнопка «Стежити за ціною» на результатах пошуку."
)
HELP_HTML = (
    "<b>Що я вмію</b>\n"
    "/new — нова підписка на ціну\n/list — мої підписки (вимкнути, змінити поріг)\n"
    "/stop — вимкнути всі підписки\n/link — прив'язати до акаунта на сайті\n"
    "/cancel — скасувати поточну дію"
)
LINK_HELP_HTML = (
    "🔗 Щоб прив'язати Telegram до акаунта, відкрийте на сайті <b>Кабінет → Вхід і безпека → "
    "Telegram</b> і натисніть «Прив'язати Telegram». "
    "Тоді підписки з цього чату з'являться в кабінеті."
)
BAD_DATE_TEXT = "Не зрозумів дату. Напишіть, наприклад, 05.12 або 2026-12-05 (не в минулому)."
UNKNOWN_LINK_TEXT = "Посилання застаріле або вже використане. Створіть нове на сайті."
