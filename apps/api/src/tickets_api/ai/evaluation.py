"""Оцінка якості розбору на наборі тестових запитів (tests/fixtures/llm_eval/).

Спільне для pytest (на записаних відповідях моделі) і scripts/eval_parser.py (наживо).
"""

import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from tickets_api.ai.parser import ParseContext, ParseResult
from tickets_api.llm.types import ChatRequest, ChatResponse, LLMError, ToolCall, Usage

CASES_PATH = Path(__file__).parents[3] / "tests" / "fixtures" / "llm_eval" / "parser_cases.json"
RECORDED_DIR = CASES_PATH.parent / "recorded"


@dataclass(frozen=True)
class Case:
    id: str
    message: str
    context: ParseContext
    expected: dict[str, Any]


def load_cases(path: Path = CASES_PATH) -> tuple[list[Case], set[str]]:
    doc = json.loads(path.read_text())
    cases = [
        Case(c["id"], c["message"], ParseContext.model_validate(c["context"]), c["expected"])
        for c in doc["cases"]
    ]
    return cases, set(doc.get("known_failures", []))


async def stub_cheapest_day(origin: str, destination: str, start: date, end: date) -> date:
    """Детермінований «календар» для оцінки: найдешевший — третій день діапазону."""
    return min(start + timedelta(days=2), end)


def check(result: ParseResult, expected: dict[str, Any]) -> list[str]:
    """Розбіжності з очікуваним (порожньо — кейс пройдено)."""
    errors: list[str] = []

    def fail(field: str, got: object) -> None:
        errors.append(f"{field}: очікували {expected.get(field)!r}, отримали {got!r}")

    if result.status != expected["status"]:
        fail("status", result.status)
        return errors
    if expected.get("has_question") and not result.clarifying_question:
        fail("has_question", result.clarifying_question)
    for note in expected.get("notes_include", []):
        if note not in result.notes:
            errors.append(f"notes: немає {note!r} у {result.notes}")
    q = result.query
    if q is None:
        return errors
    if "origin" in expected and q.origin not in expected["origin"]:
        fail("origin", q.origin)
    if "destination" in expected and q.destination not in expected["destination"]:
        fail("destination", q.destination)
    if "departure" in expected:
        want = expected["departure"]
        got = q.departure_date.isoformat()
        ok = got == want if isinstance(want, str) else want[0] <= got <= want[1]
        if not ok:
            fail("departure", got)
    if "return_date" in expected:
        got_ret = q.return_date.isoformat() if q.return_date else None
        if got_ret != expected["return_date"]:
            fail("return_date", got_ret)
    if "trip_length" in expected:
        length = (q.return_date - q.departure_date).days if q.return_date else None
        if length != expected["trip_length"]:
            fail("trip_length", length)
    for field in ("adults", "children", "infants"):
        if field in expected and getattr(q.passengers, field) != expected[field]:
            fail(field, getattr(q.passengers, field))
    if "direct_only" in expected and q.direct_only != expected["direct_only"]:
        fail("direct_only", q.direct_only)
    if "max_stops" in expected and q.filters.max_stops != expected["max_stops"]:
        fail("max_stops", q.filters.max_stops)
    if "profile" in expected and q.profile != expected["profile"]:
        fail("profile", q.profile)
    if "max_price" in expected and q.filters.max_price != expected["max_price"]:
        fail("max_price", q.filters.max_price)
    if expected.get("no_night") and "night" in q.filters.departure_periods:
        fail("no_night", q.filters.departure_periods)
    if expected.get("no_night") and not q.filters.departure_periods:
        fail("no_night", q.filters.departure_periods)
    return errors


# --- запис і відтворення відповідей моделі ---------------------------------------


def dump_responses(responses: list[ChatResponse]) -> list[dict[str, Any]]:
    return [
        {
            "model": r.model,
            "content": r.content,
            "tool_calls": [
                {"id": c.id, "name": c.name, "arguments": c.arguments} for c in r.tool_calls
            ],
            "usage": [r.usage.input_cache_hit, r.usage.input_cache_miss, r.usage.output],
            "finish_reason": r.finish_reason,
        }
        for r in responses
    ]


def load_responses(raw: list[dict[str, Any]]) -> list[ChatResponse]:
    return [
        ChatResponse(
            model=r["model"],
            content=r["content"],
            tool_calls=tuple(ToolCall(**c) for c in r["tool_calls"]),
            usage=Usage(*r["usage"]),
            finish_reason=r["finish_reason"],
        )
        for r in raw
    ]


class RecordingClient:
    """Пропускає виклики до справжнього клієнта і запам'ятовує відповіді."""

    def __init__(self, inner: Any) -> None:
        self.name = inner.name
        self._inner = inner
        self.responses: list[ChatResponse] = []

    async def chat(self, request: ChatRequest) -> ChatResponse:
        response: ChatResponse = await self._inner.chat(request)
        self.responses.append(response)
        return response


class ReplayClient:
    """Віддає записані відповіді по черзі — тест без мережі й без витрат."""

    name = "replay"

    def __init__(self, responses: list[ChatResponse]) -> None:
        self._responses = list(responses)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if not self._responses:
            raise LLMError(self.name, "no more recorded responses")
        return self._responses.pop(0)
