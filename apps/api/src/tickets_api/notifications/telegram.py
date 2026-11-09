"""Telegram Bot API: лише потрібні методи (https://core.telegram.org/bots/api).

- запит: POST https://api.telegram.org/bot<token>/<method>, відповідь {"ok", "result"};
- sendMessage / editMessageText: chat_id, text (1–4096 символів), parse_mode "HTML"
  (екрануємо <, >, &), link_preview_options, reply_markup з inline_keyboard;
- кнопки: text + url (лише публічні https) або callback_data (1–64 байти);
- answerCallbackQuery: callback_query_id, text (0–200); setMyCommands: commands
  (command — 1–32 символи [a-z0-9_], description — 1–256);
- getUpdates: offset (оновлення підтверджене, коли offset > update_id), timeout,
  allowed_updates. Опитування замість webhook — публічна адреса не потрібна.

Токен — частина URL, тож у помилки й логи URL не потрапляє.
"""

import html
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
import structlog

log = structlog.get_logger(__name__)

MAX_TEXT = 4096
MAX_CALLBACK_DATA = 64


class TelegramError(Exception):
    pass


@dataclass(frozen=True)
class Button:
    text: str
    url: str | None = None
    data: str | None = None
    """callback_data — бот отримає її в callback_query (1–64 байти)."""


Keyboard = Sequence[Sequence[Button]]


def esc(text: object) -> str:
    """Екранування для parse_mode=HTML (<, >, & — обов'язково)."""
    return html.escape(str(text), quote=False)


def keyboard_markup(keyboard: Keyboard) -> dict[str, Any] | None:
    """Кнопки-посилання Telegram приймає лише з публічними https-адресами (не localhost)."""
    rows = []
    for row in keyboard:
        buttons = []
        for b in row:
            if b.data is not None and 0 < len(b.data.encode()) <= MAX_CALLBACK_DATA:
                buttons.append({"text": b.text, "callback_data": b.data})
            elif b.url is not None and b.url.startswith("https://"):
                buttons.append({"text": b.text, "url": b.url})
        if buttons:
            rows.append(buttons)
    return {"inline_keyboard": rows} if rows else None


class TelegramClient(Protocol):
    name: str

    async def send_message(
        self, chat_id: int, text: str, keyboard: Keyboard = (), *, html: bool = False
    ) -> None: ...

    async def edit_message(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        keyboard: Keyboard = (),
        *,
        html: bool = False,
    ) -> None: ...

    async def answer_callback(self, callback_id: str, text: str | None = None) -> None: ...

    async def set_commands(
        self, commands: Sequence[tuple[str, str]], *, language_code: str | None = None
    ) -> None: ...

    async def get_updates(self, offset: int | None) -> list[dict[str, Any]]: ...


class TelegramBot:
    name = "telegram"

    def __init__(
        self, http: httpx.AsyncClient, token: str, *, base_url: str = "https://api.telegram.org"
    ) -> None:
        self._http = http
        self._url = f"{base_url.rstrip('/')}/bot{token}"

    async def send_message(
        self, chat_id: int, text: str, keyboard: Keyboard = (), *, html: bool = False
    ) -> None:
        await self._call("sendMessage", _message(chat_id, text, keyboard, html))

    async def edit_message(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        keyboard: Keyboard = (),
        *,
        html: bool = False,
    ) -> None:
        payload = _message(chat_id, text, keyboard, html)
        payload["message_id"] = message_id
        await self._call("editMessageText", payload)

    async def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        payload: dict[str, Any] = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text[:200]
        await self._call("answerCallbackQuery", payload)

    async def set_commands(
        self, commands: Sequence[tuple[str, str]], *, language_code: str | None = None
    ) -> None:
        """Без `language_code` — меню за замовчуванням; з ним — для користувачів цієї мови."""
        payload: dict[str, Any] = {
            "commands": [{"command": c, "description": d[:256]} for c, d in commands]
        }
        if language_code:
            payload["language_code"] = language_code
        await self._call("setMyCommands", payload)

    async def get_updates(self, offset: int | None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": 0, "allowed_updates": ["message", "callback_query"]}
        if offset is not None:
            payload["offset"] = offset
        result = await self._call("getUpdates", payload)
        return [u for u in result if isinstance(u, dict)] if isinstance(result, list) else []

    async def _call(self, method: str, payload: dict[str, Any]) -> Any:
        try:
            response = await self._http.post(f"{self._url}/{method}", json=payload, timeout=15)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # str(exc) може містити URL з токеном — лише тип помилки.
            raise TelegramError(f"{method}: {type(exc).__name__}") from exc
        if not isinstance(body, dict) or not body.get("ok"):
            code = body.get("error_code") if isinstance(body, dict) else None
            raise TelegramError(f"{method}: HTTP {response.status_code}, error_code={code}")
        return body.get("result")


def _message(chat_id: int, text: str, keyboard: Keyboard, html: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text[:MAX_TEXT],
        "link_preview_options": {"is_disabled": True},
    }
    if html:
        payload["parse_mode"] = "HTML"
    markup = keyboard_markup(keyboard)
    if markup:
        payload["reply_markup"] = markup
    return payload


@dataclass
class SentMessage:
    chat_id: int
    text: str
    keyboard: list[list[Button]]
    html: bool
    message_id: int | None = None
    """Не None — це редагування наявного повідомлення."""


class MockTelegram:
    """Без токена: повідомлення лише в лог (і в `sent` — для тестів)."""

    name = "mock"

    def __init__(self) -> None:
        self.sent: list[SentMessage] = []
        self.updates: list[dict[str, Any]] = []
        self.answered: list[tuple[str, str | None]] = []
        self.commands: list[tuple[str, str]] = []
        self.commands_by_language: dict[str | None, list[tuple[str, str]]] = {}

    async def send_message(
        self, chat_id: int, text: str, keyboard: Keyboard = (), *, html: bool = False
    ) -> None:
        self.sent.append(SentMessage(chat_id, text, [list(r) for r in keyboard], html))
        log.info("telegram.mock_message", chat_id=chat_id, length=len(text))

    async def edit_message(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        keyboard: Keyboard = (),
        *,
        html: bool = False,
    ) -> None:
        self.sent.append(SentMessage(chat_id, text, [list(r) for r in keyboard], html, message_id))

    async def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        self.answered.append((callback_id, text))

    async def set_commands(
        self, commands: Sequence[tuple[str, str]], *, language_code: str | None = None
    ) -> None:
        self.commands_by_language[language_code] = list(commands)
        if language_code is None:
            self.commands = list(commands)

    async def get_updates(self, offset: int | None) -> list[dict[str, Any]]:
        return [u for u in self.updates if offset is None or u["update_id"] >= offset]
