"""Клієнт DeepSeek на ЗАПИСАНИХ реальних відповідях (tests/fixtures/deepseek/)."""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from tickets_api.llm.deepseek import CHAT_PATH, DeepSeekClient
from tickets_api.llm.types import ChatRequest, LLMError, Message, Tool, ToolCall

BASE = "https://deepseek.test"
URL = f"{BASE}{CHAT_PATH}"
KEY = "sk-secret-deepseek"
FIXTURES = Path(__file__).parent / "fixtures" / "deepseek"
LOOKUP = Tool(
    name="lookup_airport",
    description="Find airports and cities by name. Returns IATA codes.",
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    },
)


def recorded(name: str) -> dict[str, Any]:
    body: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    body.pop("_request", None)
    return body


@pytest.fixture
async def client() -> Any:
    async with httpx.AsyncClient() as c:
        yield DeepSeekClient(c, KEY, base_url=BASE)


@respx.mock
async def test_tool_call_request_and_response(client: DeepSeekClient) -> None:
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=recorded("tool_call")))

    response = await client.chat(
        ChatRequest(
            model="deepseek-flash",
            messages=(
                Message("system", "Use lookup_airport."),
                Message("user", "Який код аеропорту Лісабона?"),
            ),
            tools=(LOOKUP,),
            max_tokens=200,
        )
    )

    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert body["thinking"] == {"type": "disabled"}
    assert body["tools"][0]["function"]["name"] == "lookup_airport"
    assert "response_format" not in body
    assert response.finish_reason == "tool_calls"
    [call] = response.tool_calls
    assert (call.name, json.loads(call.arguments)) == ("lookup_airport", {"query": "Lisbon"})
    assert (response.usage.input_cache_miss, response.usage.output) == (303, 41)


@respx.mock
async def test_tool_result_turn_and_json_output(client: DeepSeekClient) -> None:
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=recorded("tool_result")))
    call = ToolCall(id="call_1", name="lookup_airport", arguments='{"query": "Lisbon"}')

    response = await client.chat(
        ChatRequest(
            model="deepseek-flash",
            messages=(
                Message("user", "Лісабон?"),
                Message("assistant", "", tool_calls=(call,)),
                Message("tool", '[{"code": "LIS"}]', tool_call_id="call_1"),
            ),
            json_output=True,
        )
    )

    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][1]["tool_calls"][0]["id"] == "call_1"
    assert body["messages"][2] == {
        "role": "tool",
        "content": '[{"code": "LIS"}]',
        "tool_call_id": "call_1",
    }
    assert json.loads(response.content) == {"iata": "LIS"}
    assert (response.usage.input_cache_hit, response.usage.input_cache_miss) == (256, 162)


@pytest.mark.parametrize(
    ("status", "message", "retryable"),
    [
        (401, "auth failed", False),
        (402, "insufficient balance", False),
        (429, "rate limited", True),
        (503, "server overloaded", True),
        (418, "HTTP 418", False),
    ],
)
@respx.mock
async def test_errors_are_mapped_without_leaking(
    client: DeepSeekClient, status: int, message: str, retryable: bool
) -> None:
    respx.post(URL).mock(return_value=httpx.Response(status, json={"error": {"message": KEY}}))

    with pytest.raises(LLMError, match=message) as exc_info:
        await client.chat(ChatRequest(model="m", messages=(Message("user", "hi"),)))
    assert exc_info.value.retryable is retryable
    assert KEY not in str(exc_info.value)


@respx.mock
async def test_network_error(client: DeepSeekClient) -> None:
    respx.post(URL).mock(side_effect=httpx.ConnectError(f"boom {KEY}"))

    with pytest.raises(LLMError) as exc_info:
        await client.chat(ChatRequest(model="m", messages=(Message("user", "hi"),)))
    assert KEY not in str(exc_info.value)


@respx.mock
async def test_broken_pooled_connection_is_retried_once(client: DeepSeekClient) -> None:
    """Прод: «network error: LocalProtocolError» після обірваного попереднього запиту."""
    route = respx.post(URL).mock(
        side_effect=[
            httpx.LocalProtocolError("broken connection"),
            httpx.Response(200, json=recorded("tool_result")),
        ]
    )

    await client.chat(ChatRequest(model="m", messages=(Message("user", "hi"),)))

    assert route.call_count == 2


@respx.mock
async def test_timeout_is_not_retried(client: DeepSeekClient) -> None:
    route = respx.post(URL).mock(side_effect=httpx.ReadTimeout("slow"))

    with pytest.raises(LLMError, match="timeout"):
        await client.chat(ChatRequest(model="m", messages=(Message("user", "hi"),)))
    assert route.call_count == 1
