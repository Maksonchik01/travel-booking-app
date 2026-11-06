"""Нейтральні до провайдера типи чату з інструментами. Сервіси ШІ знають лише про них."""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: str
    """JSON-рядок від моделі — може бути невалідним, перевіряє той, хто викликає."""


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None


@dataclass(frozen=True, slots=True)
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    """JSON Schema аргументів."""


@dataclass(frozen=True, slots=True)
class Usage:
    input_cache_hit: int = 0
    input_cache_miss: int = 0
    output: int = 0

    @property
    def input(self) -> int:
        return self.input_cache_hit + self.input_cache_miss


@dataclass(frozen=True, slots=True)
class ChatRequest:
    model: str
    messages: tuple[Message, ...]
    tools: tuple[Tool, ...] = ()
    json_output: bool = False
    max_tokens: int = 1024
    temperature: float | None = None


@dataclass(frozen=True, slots=True)
class ChatResponse:
    model: str
    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    usage: Usage = field(default_factory=Usage)
    finish_reason: str = "stop"


class LLMError(Exception):
    """Модель не відповіла. Повідомлення без ключів і тіл запиту (там текст користувача)."""

    def __init__(self, provider: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message
        self.retryable = retryable


class LLMClient(Protocol):
    name: str

    async def chat(self, request: ChatRequest) -> ChatResponse: ...
