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
from typing import Any, Literal

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.ai.explainer import money_text
from tickets_api.db.models import Alert, AuthToken, User
from tickets_api.domain.alerts import AlertCreate
from tickets_api.domain.locale import UiLocale
from tickets_api.i18n import LOCALES, as_locale, current_locale, t, telegram_locale, use_locale
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
COMMANDS: tuple[str, ...] = ("new", "list", "link", "stop", "cancel", "help")


def commands() -> list[tuple[str, str]]:
    """Меню «/» мовою контексту."""
    return [(c, t(f"bot.commands.{c}")) for c in COMMANDS]


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
        """Меню команд (кнопка «/» у Telegram) — для кожної мови, за замовчуванням — англійське
        (будь-яка інша мова Telegram). Збій — не критичний."""
        try:
            for locale in LOCALES:
                with use_locale(locale):
                    await self._telegram.set_commands(commands(), language_code=locale)
            with use_locale("en"):
                await self._telegram.set_commands(commands())
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
        """Одне оновлення — мовою людини (модуль 18.1): прив'язаного акаунта, інакше — мовою
        Telegram; нічого не відомо — за замовчуванням."""
        callback = update_.get("callback_query")
        message = callback.get("message") if isinstance(callback, dict) else update_.get("message")
        source = callback if isinstance(callback, dict) else message
        sender = source.get("from") if isinstance(source, dict) else None
        chat = message.get("chat") if isinstance(message, dict) else None
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        language = sender.get("language_code") if isinstance(sender, dict) else None
        account = await self._account_locale(chat_id) if isinstance(chat_id, int) else None
        with use_locale(account or telegram_locale(language)):
            await self._handle(update_)

    async def _account_locale(self, chat_id: int) -> UiLocale | None:
        async with self._sessionmaker() as session:
            locale = await session.scalar(
                select(User.locale).where(User.telegram_chat_id == chat_id)
            )
        return as_locale(locale)

    async def _handle(self, update_: dict[str, Any]) -> None:
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
            await self._send(chat_id, t("bot.help_html"), [[_new_button()]])

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
            await self._send(chat_id, t("bot.welcome_html"), main_menu())
        elif command == "/new":
            await self._start_new(chat_id)
        elif command == "/list":
            await self._list(chat_id)
        elif command == "/stop":
            stopped = await self._alerts.stop_for_chat(chat_id)
            await self._clear_dialog(chat_id)
            await self._send(chat_id, t("bot.stopped_all", count=stopped))
        elif command == "/cancel":
            await self._clear_dialog(chat_id)
            await self._send(chat_id, t("bot.cancelled"), main_menu())
        elif command == "/link":
            await self._send(chat_id, t("bot.link_help_html"))
        else:
            await self._send(chat_id, t("bot.help_html"), main_menu())

    async def _confirm_site_alert(self, chat_id: int, token: str) -> None:
        alert = await self._alerts.bind_telegram(token, chat_id)
        if alert is None:
            await self._send(chat_id, t("bot.unknown_link"), main_menu())
            return
        await self._attach_owner(chat_id, alert.id)
        await self._send(
            chat_id,
            t(
                "bot.confirmed_html",
                route=esc(route_text(alert)),
                condition=esc(condition_text(alert)),
            ),
            self._keyboard(alert),
        )
        await self._alerts.check(alert.id)  # перша перевірка — одразу

    async def _list(self, chat_id: int) -> None:
        alerts = await self._alerts.chat_alerts(chat_id)
        if not alerts:
            await self._send(chat_id, t("bot.no_alerts"), [[_new_button()]])
            return
        lines = [t("bot.list_title_html")]
        rows: list[list[Button]] = []
        for i, a in enumerate(alerts[:10], start=1):
            price = (
                t("bot.list_price", price=esc(_money(a.last_price, a.currency)))
                if a.last_price
                else ""
            )
            lines.append(f"{i}. {esc(route_text(a))} — {esc(condition_text(a))}{price}")
            rows.append(
                [
                    Button(t("bot.button.stop_n", n=i), data=f"stop:{a.id}"),
                    Button(t("bot.button.threshold"), data=f"thr:{a.id}"),
                ]
            )
        rows.append([_new_button()])
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
            await self._send(chat_id, t("bot.unknown_link"), main_menu())
            return
        await self._send(chat_id, t("bot.linked_html", username=esc(user.username)), main_menu())

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
            await self._ack(callback_id, t("bot.ack.stopped" if stopped else "bot.ack.already"))
            if stopped:
                await self._send(
                    chat_id, t("bot.stopped_one"), [[Button(t("bot.button.list"), data="list")]]
                )
        elif action == "snooze":
            until = await self._alerts.snooze_for_chat(chat_id, value)
            await self._ack(
                callback_id,
                t("bot.ack.snoozed", date=f"{until:%d.%m}") if until else t("bot.ack.inactive"),
            )
        elif action == "thr":
            alert = await self._alerts.chat_alert(chat_id, value)
            await self._ack(callback_id)
            if alert is None or alert.status != "active":
                await self._send(chat_id, t("bot.inactive"))
                return
            await self._save_dialog(chat_id, Dialog(step="edit_threshold", alert_id=alert.id))
            await self._send(
                chat_id,
                t(
                    "bot.new_threshold_html",
                    route=esc(route_text(alert)),
                    party=esc(party_text(alert)),
                    currency=esc(alert.currency),
                ),
                threshold_buttons(),
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
            await self._ack(callback_id, t("bot.ack.cancelled"))
            await self._clear_dialog(chat_id)
        else:
            await self._ack(callback_id)

    # --- діалог нової підписки --------------------------------------------------------

    async def _start_new(self, chat_id: int) -> None:
        await self._save_dialog(chat_id, Dialog(step="origin"))
        await self._send(chat_id, t("bot.new_html"), cancel())

    async def _answer(self, chat_id: int, dialog: Dialog, text: str) -> None:
        if dialog.step in ("origin", "destination"):
            await self._place(chat_id, dialog, text)
        elif dialog.step == "departure":
            day = parse_date(text, self._alerts.now().date())
            if day is None or not self._in_range(day):
                await self._send(chat_id, t("bot.bad_date"), cancel())
                return
            dialog.departure = day.isoformat()
            dialog.step = "return"
            await self._save_dialog(chat_id, dialog)
            await self._send(
                chat_id,
                t("bot.ask_return"),
                [[Button(t("bot.button.one_way"), data="ow"), _cancel_button()]],
            )
        elif dialog.step == "return":
            day = parse_date(text, self._alerts.now().date())
            departure = date.fromisoformat(dialog.departure or "")
            if day is None or day < departure or not self._in_range(day):
                await self._send(chat_id, t("bot.return_before") + t("bot.bad_date"))
                return
            dialog.return_date = day.isoformat()
            dialog.step = "threshold"
            await self._save_dialog(chat_id, dialog)
            await self._ask_threshold(chat_id)
        elif dialog.step in ("threshold", "edit_threshold"):
            amount = parse_amount(text)
            if amount is None:
                await self._send(chat_id, t("bot.amount_hint_html"), threshold_buttons())
                return
            await self._finish(chat_id, dialog, amount)

    async def _place(self, chat_id: int, dialog: Dialog, text: str) -> None:
        # Назви в довіднику — українською й англійською; для російської кирилиця ближча.
        lang: Literal["uk", "en"] = "en" if current_locale() == "en" else "uk"
        places = self._airports.search(text, limit=4, lang=lang) if len(text) >= 2 else []
        if not places:
            await self._send(chat_id, t("bot.not_found", text=esc(text[:40])), cancel())
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
        rows.append([_cancel_button()])
        await self._send(chat_id, t("bot.clarify"), rows)

    async def _place_chosen(self, chat_id: int, dialog: Dialog, code: str) -> None:
        if dialog.step == "origin":
            dialog.origin = code
            dialog.step = "destination"
            await self._save_dialog(chat_id, dialog)
            await self._send(chat_id, t("bot.from_html", code=esc(code)), cancel())
            return
        if code == dialog.origin:
            await self._send(chat_id, t("bot.same_city"), cancel())
            return
        dialog.destination = code
        dialog.step = "departure"
        await self._save_dialog(chat_id, dialog)
        route = f"{esc(dialog.origin)} → {esc(code)}"
        await self._send(chat_id, t("bot.ask_departure_html", route=route), cancel())

    async def _ask_threshold(self, chat_id: int) -> None:
        await self._send(chat_id, t("bot.ask_threshold_html"), threshold_buttons())

    async def _finish(self, chat_id: int, dialog: Dialog, amount: int | None) -> None:
        await self._clear_dialog(chat_id)
        if dialog.step == "edit_threshold" and dialog.alert_id:
            if amount is None:
                await self._send(chat_id, t("bot.typical_edit"))
                return
            ok = await self._alerts.set_threshold_for_chat(chat_id, dialog.alert_id, amount)
            await self._send(
                chat_id, t("bot.threshold_set_html", amount=amount) if ok else t("bot.inactive")
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
                locale=current_locale(),
            )
            created = await self._alerts.create(body, await self._owner(chat_id), chat_id=chat_id)
        except (AlertError, ValueError) as exc:
            log.info("bot.new_alert_rejected", error=type(exc).__name__)
            await self._send(chat_id, t("bot.create_failed"))
            return
        alert = await self._alerts.chat_alert(chat_id, created.id)
        if alert is None:
            return
        price = (
            t(
                "bot.now_from_html",
                price=esc(_money(alert.last_price, alert.currency)),
                party=esc(party_text(alert)),
            )
            if alert.last_price is not None
            else t("bot.no_history")
        )
        await self._send(
            chat_id,
            t(
                "bot.watching_html",
                route=esc(route_text(alert)),
                condition=esc(condition_text(alert)),
                price=price,
            ),
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


def _new_button() -> Button:
    return Button(t("bot.button.new"), data="new")


def _cancel_button() -> Button:
    return Button(t("bot.button.cancel"), data="cancel")


def main_menu() -> list[list[Button]]:
    return [[_new_button(), Button(t("bot.button.list"), data="list")]]


def cancel() -> list[list[Button]]:
    return [[_cancel_button()]]


def threshold_buttons() -> list[list[Button]]:
    return [[Button(t("bot.button.typical"), data="typ"), _cancel_button()]]


def unknown_link_text() -> str:
    """Для тестів і повідомлень поза ботом — мовою контексту."""
    return t("bot.unknown_link")
