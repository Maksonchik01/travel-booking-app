import json
from collections.abc import AsyncIterator

import httpx
import pytest
import respx
from tickets_api.notifications.telegram import Button, TelegramBot, TelegramError, esc

TOKEN = "123456:secret-token-value"  # noqa: S105 — фіктивний токен для тесту
BASE = f"https://api.telegram.org/bot{TOKEN}"


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as c:
        yield c


@respx.mock
async def test_send_message_html_and_buttons(client: httpx.AsyncClient) -> None:
    route = respx.post(f"{BASE}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
    )
    bot = TelegramBot(client, TOKEN)

    await bot.send_message(
        42,
        "x" * 5000,
        [
            [Button("Квитки", url="https://tickets.example/?from=WAW")],
            [Button("Локально", url="http://localhost:3000"), Button("Вимкнути", data="stop:a1")],
            [Button("Задовго", data="x" * 65)],
        ],
        html=True,
    )

    body = json.loads(route.calls.last.request.content)
    assert body["chat_id"] == 42
    assert len(body["text"]) == 4096  # ліміт Bot API
    assert body["parse_mode"] == "HTML"
    assert body["link_preview_options"] == {"is_disabled": True}
    # localhost-посилання Telegram не приймає; callback_data — до 64 байтів.
    assert body["reply_markup"] == {
        "inline_keyboard": [
            [{"text": "Квитки", "url": "https://tickets.example/?from=WAW"}],
            [{"text": "Вимкнути", "callback_data": "stop:a1"}],
        ]
    }


@respx.mock
async def test_callback_answer_commands_and_edit(client: httpx.AsyncClient) -> None:
    answer = respx.post(f"{BASE}/answerCallbackQuery").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": True})
    )
    commands = respx.post(f"{BASE}/setMyCommands").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": True})
    )
    edit = respx.post(f"{BASE}/editMessageText").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 7}})
    )
    bot = TelegramBot(client, TOKEN)

    await bot.answer_callback("cb1", "Готово")
    await bot.set_commands([("new", "Нова підписка")])
    await bot.edit_message(42, 7, "Оновлено")

    assert json.loads(answer.calls.last.request.content) == {
        "callback_query_id": "cb1",
        "text": "Готово",
    }
    assert json.loads(commands.calls.last.request.content) == {
        "commands": [{"command": "new", "description": "Нова підписка"}]
    }
    assert json.loads(edit.calls.last.request.content)["message_id"] == 7
    assert esc("<b>&") == "&lt;b&gt;&amp;"


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
    assert body == {"timeout": 0, "allowed_updates": ["message", "callback_query"], "offset": 5}


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
