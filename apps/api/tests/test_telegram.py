import json
from collections.abc import AsyncIterator

import httpx
import pytest
import respx
from tickets_api.notifications.telegram import TelegramBot, TelegramError

TOKEN = "123456:secret-token-value"  # noqa: S105 — фіктивний токен для тесту
BASE = f"https://api.telegram.org/bot{TOKEN}"


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as c:
        yield c


@respx.mock
async def test_send_message_with_public_url_buttons_only(client: httpx.AsyncClient) -> None:
    route = respx.post(f"{BASE}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
    )
    bot = TelegramBot(client, TOKEN)

    await bot.send_message(
        42,
        "x" * 5000,
        [("Квитки", "https://tickets.example/?from=WAW"), ("Локально", "http://localhost:3000")],
    )

    body = json.loads(route.calls.last.request.content)
    assert body["chat_id"] == 42
    assert len(body["text"]) == 4096  # ліміт Bot API
    assert body["link_preview_options"] == {"is_disabled": True}
    # Telegram не приймає кнопки з localhost — лишаємо лише публічні https.
    assert body["reply_markup"] == {
        "inline_keyboard": [[{"text": "Квитки", "url": "https://tickets.example/?from=WAW"}]]
    }


@respx.mock
async def test_get_updates_passes_offset(client: httpx.AsyncClient) -> None:
    route = respx.post(f"{BASE}/getUpdates").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "result": [{"update_id": 5, "message": {"text": "/list"}}]}
        )
    )

    updates = await TelegramBot(client, TOKEN).get_updates(5)

    assert updates[0]["update_id"] == 5
    body = json.loads(route.calls.last.request.content)
    assert body == {"timeout": 0, "allowed_updates": ["message"], "offset": 5}


@respx.mock
async def test_errors_never_leak_token(client: httpx.AsyncClient) -> None:
    respx.post(f"{BASE}/sendMessage").mock(
        return_value=httpx.Response(
            403, json={"ok": False, "error_code": 403, "description": "bot was blocked"}
        )
    )
    respx.post(f"{BASE}/getUpdates").mock(side_effect=httpx.ConnectError("boom"))
    bot = TelegramBot(client, TOKEN)

    with pytest.raises(TelegramError) as blocked:
        await bot.send_message(42, "hi")
    with pytest.raises(TelegramError) as network:
        await bot.get_updates(None)

    for error in (blocked.value, network.value):
        assert TOKEN not in str(error)
        assert "secret" not in str(error)
