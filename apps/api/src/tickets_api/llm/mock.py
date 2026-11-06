"""Детермінована «модель» для e2e і розробки без ключа (LLM_PROVIDER=mock).

Не імітує розуміння мови: розбір завжди дає WAW → LIS через місяць на тиждень (або
уточнення, якщо за всю розмову сказано менше двох слів), пояснення будується з готових
чисел вхідних даних.
"""

import json
from datetime import date, timedelta
from typing import Any

from tickets_api.llm.types import ChatRequest, ChatResponse, ToolCall, Usage

MOCK_USAGE = Usage(input_cache_miss=100, output=50)


class MockLLMClient:
    name = "mock"

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if any(t.name == "search_flights" for t in request.tools):
            return _assistant_answer(request)
        payload = _user_payload(request)
        # Розбір запиту — єдина роль з інструментами.
        content = _parse_answer(payload) if request.tools else _explain_answer(payload)
        return ChatResponse(
            model=request.model, content=json.dumps(content, ensure_ascii=False), usage=MOCK_USAGE
        )


def _assistant_answer(request: ChatRequest) -> ChatResponse:
    """Агент: коротка репліка — питання; інакше пошук WAW → LIS і текст з його результату."""
    tool_results = [m for m in request.messages if m.role == "tool"]
    if tool_results:
        result = json.loads(tool_results[-1].content)
        options = {o["id"]: o for o in result.get("options", [])}
        best = options.get(result.get("recommended_by_scoring") or "")
        text = (
            f"Знайшов варіанти. {best['title']} — {best['price_text']}, ціна отримана "
            f"{best['price_age_text']}."
            if best
            else "На ці дати нічого не знайшлося. Спробуйте іншу дату."
        )
        return ChatResponse(model=request.model, content=text, usage=MOCK_USAGE)
    said = " ".join(m.content for m in request.messages if m.role == "user")
    if len(said.split()) < 2:
        return ChatResponse(
            model=request.model, content="Куди і коли ви хочете полетіти?", usage=MOCK_USAGE
        )
    context = json.loads(request.messages[0].content.rsplit("\n", 1)[-1])
    departure = date.fromisoformat(context["today"]) + timedelta(days=31)
    arguments = {"origin": "WAW", "destination": "LIS", "departure_date": departure.isoformat()}
    call = ToolCall(id="mock-1", name="search_flights", arguments=json.dumps(arguments))
    return ChatResponse(model=request.model, content="", tool_calls=(call,), usage=MOCK_USAGE)


def _user_payload(request: ChatRequest) -> dict[str, Any]:
    first_user = next(m for m in request.messages if m.role == "user")
    data: dict[str, Any] = json.loads(first_user.content)
    return data


def _parse_answer(payload: dict[str, Any]) -> dict[str, Any]:
    said = [t["text"] for t in payload.get("conversation", []) if t["role"] == "user"]
    message = " ".join([*said, str(payload.get("user_message", ""))])
    if len(message.split()) < 2:
        return {
            "intent": "flights",
            "needs_clarification": True,
            "clarifying_question": "Куди і коли ви хочете полетіти?",
        }
    today = date.fromisoformat(payload["context"]["today"])
    return {
        "intent": "flights",
        "origin": {"raw": "Варшава", "iata": "WAW", "type": "airport"},
        "destination": {"raw": "Лісабон", "iata": "LIS", "type": "airport"},
        "dates": {"departure": (today + timedelta(days=31)).isoformat(), "trip_length_days": 7},
        "passengers": {"adults": 1},
        "profile": "balanced",
        "needs_clarification": False,
    }


def _explain_answer(payload: dict[str, Any]) -> dict[str, Any]:
    options = payload["options"]
    ids = [o["id"] for o in options]
    recommended = "balanced" if "balanced" in ids else ids[0]
    best = next(o for o in options if o["id"] == recommended)
    return {
        "summary": f"Варіант за {best['price_text']} має найкращий баланс ціни й часу.",
        "recommended_id": recommended,
        "recommendation_reason": "Найменша оцінка серед варіантів для вашого профілю.",
        "options": [
            {
                "id": o["id"],
                "pros": [f"Ціна {o['price_text']}"],
                "cons": [],
                "risks": [],
                "one_liner": f"{o['price_text']}, у дорозі {o['duration_text']}",
            }
            for o in options
        ],
        "price_assessment": {"available": False, "text": "Історії цін поки замало."},
        "timing_advice": {"available": False, "text": "Прогнозу немає."},
        "data_freshness_note": "Ціни отримано під час пошуку.",
        "flags": [],
    }
