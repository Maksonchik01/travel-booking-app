"""DeepSeek Chat Completions (формат OpenAI): https://api-docs.deepseek.com/.

Звірено з документацією і реальними відповідями (листопад 2026, tests/fixtures/deepseek/):
- POST {base}/chat/completions, `Authorization: Bearer <key>`;
- `thinking: {"type": "disabled"}` — без режиму міркувань: дешевше й швидше, а
  `tool_choice` у режимі міркувань обмежений. Нам міркування не потрібні — числа рахує код;
- `response_format: {"type": "json_object"}` гарантує валідний JSON (якщо не обрізано
  через `finish_reason="length"`);
- `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` — для точної вартості;
- `tool_calls[].function.arguments` — JSON-рядок, може бути невалідним;
- помилки: 400/422 — наш запит, 401 — ключ, 402 — немає коштів, 429 — ліміт, 500/503 — збій.
"""

from typing import Any

import httpx

from tickets_api.llm.types import ChatRequest, ChatResponse, LLMError, Message, ToolCall, Usage

DEFAULT_BASE_URL = "https://api.deepseek.com"
CHAT_PATH = "/chat/completions"
_ERRORS = {
    400: ("invalid request (HTTP 400)", False),
    401: ("auth failed (HTTP 401)", False),
    402: ("insufficient balance (HTTP 402)", False),
    422: ("invalid parameters (HTTP 422)", False),
    429: ("rate limited (HTTP 429)", True),
    500: ("server error (HTTP 500)", True),
    503: ("server overloaded (HTTP 503)", True),
}


CONNECTION_ATTEMPTS = 2
RECONNECT_ERRORS = (httpx.ConnectError, httpx.LocalProtocolError, httpx.RemoteProtocolError)
"""Збій з'єднання до відповіді — повторюємо раз; тайм-аут — ні (запит міг виконатися)."""


class DeepSeekClient:
    name = "deepseek"

    def __init__(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 45.0,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s

    async def chat(self, request: ChatRequest) -> ChatResponse:
        for attempt in range(CONNECTION_ATTEMPTS):
            try:
                response = await self._client.post(
                    f"{self._base_url}{CHAT_PATH}",
                    json=_body(request),
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=self._timeout_s,
                )
                break
            except httpx.TimeoutException as exc:
                raise LLMError(self.name, "timeout", retryable=True) from exc
            except RECONNECT_ERRORS as exc:
                # З'єднання з пулу зіпсоване (попередній запит обірвали посередині, напр. браузер
                # не дочекався) — httpx його відкидає, повтор іде новим. Прод: «LocalProtocolError».
                if attempt + 1 < CONNECTION_ATTEMPTS:
                    continue
                raise LLMError(
                    self.name, f"network error: {type(exc).__name__}", retryable=True
                ) from exc
            except httpx.HTTPError as exc:
                raise LLMError(
                    self.name, f"network error: {type(exc).__name__}", retryable=True
                ) from exc

        if response.status_code != 200:
            message, retryable = _ERRORS.get(
                response.status_code, (f"HTTP {response.status_code}", response.status_code >= 500)
            )
            raise LLMError(self.name, message, retryable=retryable)
        try:
            return _parse(response.json())
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(self.name, "unexpected response shape") from exc


def _body(request: ChatRequest) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": request.model,
        "messages": [_message(m) for m in request.messages],
        "thinking": {"type": "disabled"},
        "max_tokens": request.max_tokens,
    }
    if request.tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in request.tools
        ]
    if request.json_output:
        body["response_format"] = {"type": "json_object"}
    if request.temperature is not None:
        body["temperature"] = request.temperature
    return body


def _message(message: Message) -> dict[str, Any]:
    out: dict[str, Any] = {"role": message.role, "content": message.content}
    if message.tool_calls:
        out["tool_calls"] = [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
            for c in message.tool_calls
        ]
    if message.tool_call_id is not None:
        out["tool_call_id"] = message.tool_call_id
    return out


def _parse(payload: dict[str, Any]) -> ChatResponse:
    choice = payload["choices"][0]
    message = choice["message"]
    usage = payload.get("usage") or {}
    return ChatResponse(
        model=str(payload.get("model") or ""),
        content=message.get("content") or "",
        tool_calls=tuple(
            ToolCall(
                id=str(c["id"]),
                name=str(c["function"]["name"]),
                arguments=str(c["function"].get("arguments") or ""),
            )
            for c in message.get("tool_calls") or []
        ),
        usage=Usage(
            input_cache_hit=int(usage.get("prompt_cache_hit_tokens") or 0),
            input_cache_miss=int(usage.get("prompt_cache_miss_tokens") or 0),
            output=int(usage.get("completion_tokens") or 0),
        ),
        finish_reason=str(choice.get("finish_reason") or ""),
    )
