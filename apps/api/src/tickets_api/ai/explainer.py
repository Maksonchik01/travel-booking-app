"""Пояснення результатів пошуку людською мовою (роль Flight-Deal-Advisor, sub-agents/).

Ранжування вже зробив скоринг-рушій — модель лише пояснює. Щоб вона не вигадувала числа:
- усі числа, які можуть знадобитися (різниці цін і часу, тривалості текстом, вік ціни),
  код рахує сам і передає готовими — моделі нема чого обчислювати;
- після відповіді код перевіряє, що КОЖНЕ число в тексті є у вхідних даних. Ні — одна
  спроба переписати з переліком зайвих чисел; знову ні — пояснення не показуємо.
"""

import hashlib
import json
import re
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

import structlog
from pydantic import BaseModel, ConfigDict, ValidationError

from tickets_api.domain.flights import FlightQuery, Leg, Offer
from tickets_api.llm.prompts import system_prompt
from tickets_api.llm.types import ChatRequest, LLMClient, LLMError, Message
from tickets_api.repositories.price_history import PriceStats
from tickets_api.scoring.engine import OfferScore, Pick, PickLabel
from tickets_api.services.flight_search import FlightSearchResult

log = structlog.get_logger(__name__)

MIN_HISTORY_SAMPLE = 20
"""Промпт Flight-Deal-Advisor: оцінювати ціну за історією лише при sample_size ≥ 20."""
SMALL_NUMBERS = frozenset(range(0, 11))
TITLES: dict[PickLabel, str] = {
    "cheapest": "Найдешевший",
    "fastest": "Найшвидший",
    "balanced": "Збалансований",
}
"""Ті самі назви, що в UI (messages/uk.json → picks.label)."""
"""«2 пересадки», «1 варіант» — дрібні лічильники не вважаємо вигаданими даними."""
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")

OUTPUT_CONTRACT = """
# ТЕХНІЧНИЙ КОНТРАКТ
- "id" варіантів — точно ті, що в options[].id ("cheapest" | "fastest" | "balanced").
  У ТЕКСТІ називай варіанти лише за "title" («Збалансований»), не за id.
- Числа бери лише з вхідних даних, у тому ж вигляді: ціни з валютою як у "price_text",
  тривалості як у "duration_text", різниці — з "comparisons". Нових чисел не рахуй.
- Ризики з "risk_penalties" і "warnings" обов'язково назви в "risks" відповідного варіанта.
- null у "baggage_included" (і будь-якому полі) означає «невідомо», а НЕ «ні»/«не включено».
- Вік ціни бери з "price_age_text" (у "data_freshness_note").
- "recommended_id" = "recommended_by_scoring": ранжування вже зробив скоринг-рушій,
  ти пояснюєш його вибір, а не обираєш інший.
- Суми штрафів скорингу ("amount", "time_penalty" тощо) у тексті не згадуй — назви сам ризик.
"""


class AdvisorOption(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    pros: list[str] = []
    cons: list[str] = []
    risks: list[str] = []
    one_liner: str = ""


class Availability(BaseModel):
    model_config = ConfigDict(extra="ignore")

    available: bool = False
    text: str = ""


class Explanation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    summary: str
    recommended_id: str
    recommendation_reason: str = ""
    options: list[AdvisorOption] = []
    price_assessment: Availability = Availability()
    timing_advice: Availability = Availability()
    data_freshness_note: str = ""
    flags: list[str] = []


ExplainStatus = Literal["ok", "no_options", "unavailable", "rejected"]


class ExplainResult(BaseModel):
    status: ExplainStatus
    """rejected — модель двічі вигадала числа, пояснення не показуємо."""
    explanation: Explanation | None = None


class FlightExplainer:
    def __init__(self, *, model: str, prompts_dir: Path | None = None) -> None:
        self._model = model
        self._system = system_prompt("Flight-Deal-Advisor", prompts_dir) + "\n" + OUTPUT_CONTRACT

    @property
    def version(self) -> str:
        """Відбиток моделі й промпту: змінили промпт чи модель — кеш відповідей не підтягнеться."""
        return hashlib.sha256(f"{self._model}\n{self._system}".encode()).hexdigest()[:12]

    async def explain(
        self,
        query: FlightQuery,
        result: FlightSearchResult,
        llm: LLMClient,
        *,
        now: datetime,
        price_stats: PriceStats | None = None,
    ) -> ExplainResult:
        payload = advisor_input(query, result, now=now, price_stats=price_stats)
        if not payload["options"]:
            return ExplainResult(status="no_options")
        allowed = allowed_numbers(payload)
        ids = {o["id"] for o in payload["options"]}
        recommended = payload["recommended_by_scoring"]
        messages = [
            Message("system", self._system),
            Message("user", json.dumps(payload, ensure_ascii=False)),
        ]
        try:
            for _attempt in range(2):
                response = await llm.chat(
                    ChatRequest(
                        model=self._model,
                        messages=tuple(messages),
                        json_output=True,
                        max_tokens=1200,
                        temperature=0.3,
                    )
                )
                explanation = _parse(response.content, ids)
                if explanation is None:
                    return ExplainResult(status="rejected")
                problems = _problems(explanation, allowed, recommended)
                if not problems:
                    return ExplainResult(status="ok", explanation=explanation)
                log.info("ai.explain.rejected_attempt", problems=len(problems))
                messages += [
                    Message("assistant", response.content),
                    Message("user", " ".join(problems) + " Виправ відповідь."),
                ]
        except LLMError as exc:
            log.warning("ai.explain.llm_failed", error=exc.message)
            return ExplainResult(status="unavailable")
        return ExplainResult(status="rejected")


# --- вхідні дані для моделі ---------------------------------------------------------


def advisor_input(
    query: FlightQuery,
    result: FlightSearchResult,
    *,
    now: datetime,
    price_stats: PriceStats | None,
) -> dict[str, Any]:
    """Формат входу Flight-Deal-Advisor: до 3 Pareto-варіантів з готовими числами."""
    offers = {f"{o.source}:{o.id}": o for o in result.offers}
    scores = {s.offer_key: s for s in result.scoring.scores}
    airline_names = {a.code: a.name or a.code for a in result.facets.airlines}
    picks = [p for p in result.scoring.picks if p.offer_key in offers]
    options = [
        _option(p, offers[p.offer_key], scores.get(p.offer_key), airline_names, now) for p in picks
    ]
    comparisons = [
        _compare(a, offers[pa.offer_key], b, offers[pb.offer_key])
        for i, (pa, a) in enumerate(zip(picks, options, strict=True))
        for pb, b in list(zip(picks, options, strict=True))[i + 1 :]
    ]
    payload: dict[str, Any] = {
        "query": {
            "origin": query.origin,
            "destination": query.destination,
            "departure_date": query.departure_date.isoformat(),
            "return_date": query.return_date.isoformat() if query.return_date else None,
            "profile": query.profile,
            "adults": query.passengers.adults,
        },
        "options": options,
        "recommended_by_scoring": _recommended(picks),
        "comparisons": comparisons,
        "locale": "uk",
    }
    if price_stats is not None and price_stats.sample_size >= MIN_HISTORY_SAMPLE:
        payload["price_stats"] = price_stats.model_dump(mode="json")
    else:
        payload["price_stats"] = None
        payload["price_stats_note"] = "історії цін для цього маршруту поки замало"
    payload["forecast"] = None
    return payload


def _recommended(picks: list[Pick]) -> str | None:
    """Найкраща оцінка для профілю — це «balanced»; без нього — перший із наявних."""
    labels = [p.label for p in picks]
    return "balanced" if "balanced" in labels else (labels[0] if labels else None)


def _option(
    pick: Pick,
    offer: Offer,
    score: OfferScore | None,
    airline_names: dict[str, str],
    now: datetime,
) -> dict[str, Any]:
    legs = [offer.outbound, *([offer.inbound] if offer.inbound else [])]
    price_seen = offer.found_at or offer.collected_at
    breakdown = score.breakdown if score else None
    return {
        "id": pick.label,
        "title": TITLES[pick.label],
        "also": [TITLES[label] for label in pick.also],
        "price": _num(offer.price),
        "currency": offer.currency,
        "price_text": money_text(offer.price, offer.currency),
        "stops": offer.stops,
        "total_duration_min": offer.total_duration_min,
        "duration_text": _duration(offer.total_duration_min),
        "legs": [_leg(leg) for leg in legs],
        "airlines": [airline_names.get(c, c) for c in offer.airlines],
        "baggage_included": offer.baggage_included,
        "source": offer.source,
        "seller": offer.seller,
        "price_age_text": age_text(now - price_seen),
        "score_breakdown": (
            {
                "price": _num(breakdown.price),
                "time_penalty": _num(breakdown.time_penalty),
                "stop_penalty": _num(breakdown.stop_penalty),
                "risk_penalties": [
                    {"code": r.code, "leg": r.leg, "airport": r.airport, "amount": _num(r.amount)}
                    for r in breakdown.risk_penalties
                ],
                "total": _num(breakdown.total),
            }
            if breakdown
            else None
        ),
        "warnings": [
            {"code": w.code, "leg": w.leg, "airport": w.airport}
            for w in (score.warnings if score else [])
        ],
    }


def _leg(leg: Leg) -> dict[str, Any]:
    return {
        "from": leg.origin,
        "to": leg.destination,
        "departure_local": leg.departure_at.strftime("%Y-%m-%d %H:%M"),
        "arrival_local": leg.arrival_at.strftime("%Y-%m-%d %H:%M") if leg.arrival_at else None,
        "duration_text": _duration(leg.duration_min),
        "stops": leg.stops,
        "layovers": None
        if leg.layovers is None
        else [
            {
                "airport": lay.airport,
                "duration_text": _duration(lay.duration_min),
                "overnight": lay.overnight,
                "self_transfer": lay.self_transfer,
            }
            for lay in leg.layovers
        ],
    }


def _compare(
    a: dict[str, Any], offer_a: Offer, b: dict[str, Any], offer_b: Offer
) -> dict[str, Any]:
    """Готові різниці між двома варіантами — щоб модель не рахувала сама."""
    price_diff = offer_b.price - offer_a.price
    da, db = offer_a.total_duration_min, offer_b.total_duration_min
    duration_diff = None if da is None or db is None else db - da
    return {
        "a": a["id"],
        "b": b["id"],
        "cheaper": a["id"] if price_diff > 0 else (b["id"] if price_diff < 0 else None),
        "price_difference_text": money_text(abs(price_diff), offer_a.currency),
        "faster": None if not duration_diff else (a["id"] if duration_diff > 0 else b["id"]),
        "duration_difference_text": None
        if duration_diff is None
        else _duration(abs(duration_diff)),
    }


def age_text(delta: timedelta) -> str:
    hours = int(delta.total_seconds() // 3600)
    if hours < 1:
        return "менше години тому"
    if hours < 48:
        return f"{hours} год тому"
    return f"{hours // 24} дн тому"


def _num(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def money_text(value: Decimal, currency: str) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return f"{text} {currency}"


def _duration(minutes: int | None) -> str | None:
    if minutes is None:
        return None
    hours, mins = divmod(minutes, 60)
    if not hours:
        return f"{mins} хв"
    return f"{hours} год {mins:02d} хв" if mins else f"{hours} год"


# --- перевірка відповіді -----------------------------------------------------------------


def allowed_numbers(payload: dict[str, Any]) -> frozenset[str]:
    """Усі числа, що трапляються у вхідних даних (і як 12.5, і як 12,5)."""
    found = {_canonical(n) for n in _NUMBER.findall(json.dumps(payload, ensure_ascii=False))}
    return frozenset(found | {str(n) for n in SMALL_NUMBERS})


def invented_numbers(explanation: Explanation, allowed: frozenset[str]) -> set[str]:
    texts = [
        explanation.summary,
        explanation.recommendation_reason,
        explanation.price_assessment.text,
        explanation.timing_advice.text,
        explanation.data_freshness_note,
        *(t for o in explanation.options for t in (o.one_liner, *o.pros, *o.cons, *o.risks)),
    ]
    return {n for text in texts for n in numbers_in(text) if n not in allowed}


def numbers_in(text: str) -> set[str]:
    """Числа в тексті в канонічному вигляді (для звірки з `allowed_numbers`)."""
    return {_canonical(x) for x in _NUMBER.findall(text)}


def _canonical(number: str) -> str:
    """'88.0' / '88,00' / '88' → '88'; '4,5' → '4.5'."""
    value = Decimal(number.replace(",", "."))
    return format(value.normalize(), "f")


def _problems(explanation: Explanation, allowed: frozenset[str], recommended: str) -> list[str]:
    """Порушення контракту, які модель може виправити з другої спроби."""
    problems = []
    if explanation.recommended_id != recommended:
        problems.append(
            f'recommended_id має бути "{recommended}" — це вибір скорингу, не переранжовуй.'
        )
    invented = invented_numbers(explanation, allowed)
    if invented:
        problems.append(
            f"У відповіді є числа, яких немає у вхідних даних: {', '.join(sorted(invented))}. "
            "Використовуй лише готові значення з вхідних даних."
        )
    return problems


def _parse(content: str, ids: set[str]) -> Explanation | None:
    try:
        explanation = Explanation.model_validate_json(content)
    except ValidationError as exc:
        log.warning("ai.explain.bad_model_output", errors=exc.error_count())
        return None
    if explanation.recommended_id not in ids:
        log.warning("ai.explain.unknown_recommendation")
        return None
    # Варіантів, яких немає у вхідних даних, не показуємо (промпт: не додавати варіантів).
    explanation.options = [o for o in explanation.options if o.id in ids]
    return explanation
