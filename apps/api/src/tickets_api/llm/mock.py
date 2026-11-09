"""Детермінована «модель» для e2e і розробки без ключа (LLM_PROVIDER=mock).

Не імітує розуміння мови: розбір і агент завжди дають WAW → LIS через місяць (житло —
у Лісабоні), або одне питання, якщо за всю розмову сказано менше двох слів. Пояснення й
резюме відгуків будуються з готових чисел вхідних даних.
"""

import json
from datetime import date, timedelta
from typing import Any

from tickets_api.llm.types import ChatRequest, ChatResponse, ToolCall, Usage

MOCK_USAGE = Usage(input_cache_miss=100, output=50)


class MockLLMClient:
    name = "mock"

    async def chat(self, request: ChatRequest) -> ChatResponse:
        tools = {t.name for t in request.tools}
        if tools & {"search_flights", "search_stays", "plan_trip"}:
            return _assistant_answer(request, tools)
        payload = _user_payload(request)
        # Розбір запиту — єдина роль з інструментами; аналіз житла — вхід зі "stays".
        if request.tools:
            content = _parse_answer(payload)
        elif "stays" in payload:
            content = _stay_analysis_answer(payload)
        else:
            content = _explain_answer(payload)
        return ChatResponse(
            model=request.model, content=json.dumps(content, ensure_ascii=False), usage=MOCK_USAGE
        )


QUESTIONS = {
    "flights": "Куди і коли ви хочете полетіти?",
    "stays": "У якому місті й на які дати шукаємо житло?",
    "trip": "Звідки, куди і на які дати плануєте поїздку?",
}


def _assistant_answer(request: ChatRequest, tools: set[str]) -> ChatResponse:
    """Агент без розуміння мови. Коротка розмова (< 2 слів) — одне питання; інакше пошук
    WAW → LIS через місяць (житло — у Лісабоні на 3 ночі) і текст з готових результатів."""
    mode = "trip" if "plan_trip" in tools else ("stays" if "search_stays" in tools else "flights")
    results = [json.loads(m.content) for m in request.messages if m.role == "tool"]
    flights = next((r for r in results if "offers_found" in r), None)
    stays = next((r for r in results if "stays_found" in r), None)
    trip = next((r for r in results if "combinations_checked" in r), None)
    context = json.loads(request.messages[0].content.rsplit("\n", 1)[-1])
    departure = date.fromisoformat(context["today"]) + timedelta(days=31)

    def text(content: str) -> ChatResponse:
        return ChatResponse(model=request.model, content=content, usage=MOCK_USAGE)

    def call(name: str, arguments: dict[str, Any]) -> ChatResponse:
        tool_call = ToolCall(id=f"mock-{name}", name=name, arguments=json.dumps(arguments))
        return ChatResponse(
            model=request.model, content="", tool_calls=(tool_call,), usage=MOCK_USAGE
        )

    said = " ".join(m.content for m in request.messages if m.role == "user")
    last = next((m.content for m in reversed(request.messages) if m.role == "user"), "").lower()
    if not results and len(said.split()) < 2:
        return text(QUESTIONS[mode])
    # Модуль 9a: прості команди за ключовими словами (не розуміння мови — сценарій для e2e).
    if mode == "trip" and context.get("current_trip"):
        command = _trip_command(last, context)
        if command is not None:
            if not results:
                return call(*command)
            return text(_command_text(results[-1]))
    if mode == "flights" and context.get("current_search") and not results:
        change = _flight_change(last)
        if change:
            return call("refine_flights", change)
    if mode == "flights" and results and "active_filters" in results[-1] and flights:
        return text(_flight_text(flights) or "")
    if mode == "trip":
        if trip is None:
            return_date = departure + timedelta(days=3)
            return call(
                "plan_trip",
                {
                    "origin": "WAW",
                    "destination": "LIS",
                    "departure_date": departure.isoformat(),
                    "return_date": return_date.isoformat(),
                },
            )
        return text(_trip_text(trip))
    if mode != "stays" and flights is None:
        return call(
            "search_flights",
            {"origin": "WAW", "destination": "LIS", "departure_date": departure.isoformat()},
        )
    if mode != "flights" and stays is None:
        check_in = (flights or {}).get("query", {}).get("departure_date") or departure.isoformat()
        check_out = (date.fromisoformat(check_in) + timedelta(days=3)).isoformat()
        return call("search_stays", {"city": "LIS", "check_in": check_in, "check_out": check_out})
    return text(" ".join(filter(None, (_flight_text(flights), _stay_text(stays)))))


def _number(text: str) -> int | None:
    digits = "".join(ch if ch.isdigit() else " " for ch in text).split()
    return int(digits[-1]) if digits else None


def _flight_change(said: str) -> dict[str, Any]:
    change: dict[str, Any] = {}
    if "прям" in said:
        change["direct_only"] = True
    if "після" in said and (hour := _number(said.split("після", 1)[1][:6])) is not None:
        change["departure_after"] = min(hour, 23)
    if "бюджет" in said and (amount := _number(said.split("бюджет", 1)[1])) is not None:
        change["max_price"] = amount
    return change


def _trip_command(said: str, context: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    if "повер" in said:
        return "undo_trip", {}
    if "збереж" in said:
        return "save_trip", {}
    if "порівн" in said:
        second = "previous" if context.get("previous_trip") else "cheapest"
        return "compare_trips", {"first": "current", "second": second}
    if "швидш" in said:
        return "change_trip", {"flight": "faster", "stay": "keep"}
    if "дешевш" in said and ("готел" in said or "житл" in said):
        return "change_trip", {"flight": "keep", "stay": "cheaper"}
    if "ближч" in said:
        return "change_trip", {"flight": "keep", "stay": "closer_to_center"}
    if "бюджет" in said and (amount := _number(said)) is not None:
        key = "budget_change" if " на " in said else "budget_total"
        return "change_trip", {key: amount}
    return None


def _command_text(result: dict[str, Any]) -> str:
    if "error" in result:
        return "Не вдалося виконати: " + str(result["error"])
    if "after" in result:
        if result.get("no_better_option_found"):
            return "Кращого варіанта серед знайдених немає."
        return f"Готово: тепер разом {result['after']['money_total_text']}."
    if "second_minus_first_text" in result:
        return "Порівняння додано на панель."
    if "title" in result and "money_total_text" in result:
        return f"Зберіг поїздку «{result['title']}»."
    return "Готово."


def _trip_text(result: dict[str, Any]) -> str:
    best = _recommended(result)
    if best is None:
        return "Поїздку на ці дати скласти не вдалося."
    return (
        f"{best['title']}: разом {best['money_total_text']} ({best['breakdown_text']}). "
        f"Житло — {best['stay']['name']}."
    )


def _flight_text(result: dict[str, Any] | None) -> str | None:
    if result is None:
        return None
    best = _recommended(result)
    if best is None:
        return "Квитків на ці дати не знайшлося."
    return (
        f"Знайшов варіанти. {best['title']} — {best['price_text']}, ціна отримана "
        f"{best['price_age_text']}."
    )


def _stay_text(result: dict[str, Any] | None) -> str | None:
    if result is None:
        return None
    best = _recommended(result)
    if best is None:
        return "Житла на ці дати не знайшлося."
    return (
        f"Житло: {best['title']} — {best['name']}, {best['price_per_night_text']} за ніч, "
        f"разом {best['total_price_text']}."
    )


def _recommended(result: dict[str, Any]) -> dict[str, Any] | None:
    options = {o["id"]: o for o in result.get("options", [])}
    return options.get(result.get("recommended_by_scoring") or "")


def _stay_analysis_answer(payload: dict[str, Any]) -> dict[str, Any]:
    """Резюме без чисел: лише те, що є у вхідних даних, і завжди вибір value-score."""
    return {
        "stays": [
            {
                "id": s["id"],
                "pros": [f"Ціна {s['price_per_night_text']} за ніч."],
                "cons": [] if s["amenities"] else ["Зручності не вказані."],
                "red_flags": [],
                "reliability": "medium",
                "reliability_note": "Оцінка за наявними відгуками.",
                "best_for": "Для коротких поїздок.",
            }
            for s in payload["stays"]
        ],
        "top_pick_id": payload["recommended_by_scoring"],
        "top_pick_reason": "Найкраща оцінка вигідності серед вибраних варіантів.",
        "price_vs_location_note": "Порівняйте відстань до центру з ціною за ніч.",
        "flags": [],
    }


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
