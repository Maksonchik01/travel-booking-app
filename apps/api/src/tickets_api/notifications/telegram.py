"""Telegram Bot API: лише потрібні методи (https://core.telegram.org/bots/api).

- запит: POST https://api.telegram.org/bot<token>/<method>, відповідь {"ok", "result"};
- sendMessage: chat_id, text (1–4096 символів), link_preview_options, reply_markup з
  inline_keyboard (кнопки-посилання: text + url);
- getUpdates: offset (оновлення підтверджене, коли offset > update_id), timeout,
  allowed_updates. Опитування замість webhook — публічна адреса не потрібна.

Токен — частина URL, тож у помилки й логи URL не потрапляє.
"""

from collections.abc import Sequence
from typing import Any, Protocol

import httpx
import structlog

log = structlog.get_logger(__name__)

MAX_TEXT = 4096


class TelegramError(Exception):
    pass


class TelegramClient(Protocol):
    name: str

    async def send_message(
        self, chat_id: int, text: str, buttons: Sequence[tuple[str, str]] = ()
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
        self, chat_id: int, text: str, buttons: Sequence[tuple[str, str]] = ()
    ) -> None:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text[:MAX_TEXT],
            "link_preview_options": {"is_disabled": True},
        }
        # Кнопки-посилання Telegram приймає лише з публічними адресами (не localhost).
        public = [(label, url) for label, url in buttons if url.startswith("https://")]
        if public:
            payload["reply_markup"] = {
                "inline_keyboard": [[{"text": label, "url": url}] for label, url in public]
            }
        await self._call("sendMessage", payload)

    async def get_updates(self, offset: int | None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": 0, "allowed_updates": ["message"]}
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


class MockTelegram:
    """Без токена: повідомлення лише в лог (і в `sent` — для тестів)."""

    name = "mock"

    def __init__(self) -> None:
        self.sent: list[tuple[int, str, list[tuple[str, str]]]] = []
        self.updates: list[dict[str, Any]] = []

    async def send_message(
        self, chat_id: int, text: str, buttons: Sequence[tuple[str, str]] = ()
    ) -> None:
        self.sent.append((chat_id, text, list(buttons)))
        log.info("telegram.mock_message", chat_id=chat_id, length=len(text))

    async def get_updates(self, offset: int | None) -> list[dict[str, Any]]:
        pending = [u for u in self.updates if offset is None or u["update_id"] >= offset]
        return pending
