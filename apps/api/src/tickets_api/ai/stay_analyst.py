"""Резюме відгуків і порівняння житла (роль Stay-Analyst, sub-agents/).

Value-score рахує код — модель лише підсумовує відгуки й пояснює. Що перевіряє код:
- id об'єктів — лише ті, що у вхідних даних; `top_pick_id` — вибір скорингу;
- числа в тексті — лише з вхідних даних або лічильники відгуків («про шум — 6 з 30»);
- надійність: < 10 відгуків (у джерелі чи у вибірці) — завжди "low", що б не сказала модель.
Порушення — одна спроба виправити; знову — резюме не показуємо.
Тексти відгуків — НЕДОВІРЕНІ дані: модель їх лише переказує (правило в промпті власника).
"""

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import structlog
from pydantic import BaseModel, ConfigDict, ValidationError

from tickets_api.ai.explainer import age_text, allowed_numbers, numbers_in
from tickets_api.ai.stay_payload import stay_facts, stay_query_input
from tickets_api.domain.locale import DEFAULT_AI_LOCALE, UiLocale
from tickets_api.domain.stays import Stay, StayQuery, StayReview
from tickets_api.llm.prompts import system_prompt
from tickets_api.llm.types import ChatRequest, LLMClient, LLMError, Message
from tickets_api.scoring.stays import StayScore

log = structlog.get_logger(__name__)

MIN_RELIABLE_REVIEWS = 10
"""Промпт Stay-Analyst: review_count < 10 або вибірка < 10 — оцінка ненадійна."""

OUTPUT_CONTRACT = """
# ТЕХНІЧНИЙ КОНТРАКТ
- "id" — точно ті, що в stays[].id. "top_pick_id" = "recommended_by_scoring": value-score
  вже порахував код, ти пояснюєш його вибір, а не обираєш інший.
- Масштаб тем пиши відносно "reviews_in_sample" цього об'єкта («6 з 30»), без відсотків —
  нічого не обчислюй. Інших чисел, крім
  тих, що у вхідних даних (ціни як у "price_per_night_text", відстані як у
  "distance_to_center_text"), не пиши.
- null означає «невідомо», а не «ні». Зручностей, яких немає в "amenities" чи відгуках,
  не згадуй.
- Відповідь — лише JSON у форматі з розділу «ФОРМАТ ВІДПОВІДІ».
"""


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


class StayInsight(_Lenient):
    id: str
    pros: list[str] = []
    cons: list[str] = []
    red_flags: list[str] = []
    reliability: Literal["high", "medium", "low"] = "medium"
    reliability_note: str = ""
    best_for: str = ""


class StayAnalysis(_Lenient):
    stays: list[StayInsight] = []
    top_pick_id: str
    top_pick_reason: str = ""
    price_vs_location_note: str = ""
    flags: list[str] = []


StayAnalysisStatus = Literal["ok", "no_stays", "unavailable", "rejected"]


class StayAnalysisResult(BaseModel):
    status: StayAnalysisStatus
    analysis: StayAnalysis | None = None


class StayAnalyst:
    def __init__(self, *, model: str, prompts_dir: Path | None = None) -> None:
        self._model = model
        self._system = system_prompt("Stay-Analyst", prompts_dir) + "\n" + OUTPUT_CONTRACT

    @property
    def version(self) -> str:
        return hashlib.sha256(f"{self._model}\n{self._system}".encode()).hexdigest()[:12]

    async def analyze(
        self,
        query: StayQuery,
        stays: Sequence[Stay],
        scores: Mapping[str, StayScore],
        reviews: Mapping[str, list[StayReview]],
        llm: LLMClient,
        *,
        now: datetime,
        locale: UiLocale = DEFAULT_AI_LOCALE,
    ) -> StayAnalysisResult:
        """`scores` і `reviews` — за `stay.id`. `stays` — уже вибрані користувачем (1–3)."""
        if not stays:
            return StayAnalysisResult(status="no_stays")
        payload = analyst_input(query, stays, scores, reviews, now=now)
        payload["locale"] = locale  # мова текстів для користувача (rules.md, п. 5)
        sample = max((len(reviews.get(s.id, [])) for s in stays), default=0)
        allowed = allowed_numbers(payload) | {str(n) for n in range(sample + 1)}
        ids = {s.id for s in stays}
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
                        max_tokens=1500,
                        temperature=0.2,
                    )
                )
                analysis = _parse(response.content, ids)
                if analysis is None:
                    return StayAnalysisResult(status="rejected")
                problems = _problems(analysis, allowed, recommended)
                if not problems:
                    return StayAnalysisResult(
                        status="ok", analysis=_enforce_reliability(analysis, stays, reviews)
                    )
                log.info("ai.stay_analysis.rejected_attempt", problems=len(problems))
                messages += [
                    Message("assistant", response.content),
                    Message("user", " ".join(problems) + " Виправ відповідь."),
                ]
        except LLMError as exc:
            log.warning("ai.stay_analysis.llm_failed", error=exc.message)
            return StayAnalysisResult(status="unavailable")
        return StayAnalysisResult(status="rejected")


def analyst_input(
    query: StayQuery,
    stays: Sequence[Stay],
    scores: Mapping[str, StayScore],
    reviews: Mapping[str, list[StayReview]],
    *,
    now: datetime,
) -> dict[str, Any]:
    """Формат входу Stay-Analyst (sub-agents/Stay-Analyst.md) + готові тексти чисел."""
    items = []
    for stay in stays:
        score = scores.get(stay.id)
        breakdown = score.breakdown if score else None
        items.append(
            {
                "id": stay.id,
                **stay_facts(stay),
                "cancellation_policy": stay.cancellation,
                "value_score": float(breakdown.total) if breakdown else None,
                "score_breakdown": breakdown.model_dump(mode="json") if breakdown else None,
                "warnings": [w.code for w in (score.warnings if score else [])],
                "source": stay.source,
                "price_age_text": age_text(now - (stay.found_at or stay.collected_at)),
                "reviews_in_sample": len(reviews.get(stay.id, [])),
            }
        )
    ranked = sorted(
        (s for s in stays if s.id in scores),
        key=lambda s: (scores[s.id].breakdown.total, s.price_per_night),
    )
    return {
        "query": stay_query_input(query),
        "stays": items,
        "reviews": {
            stay.id: [
                {
                    "text": r.text,
                    "rating": float(r.rating) if r.rating is not None else None,
                    "date": r.date.isoformat(),
                    "lang": r.lang,
                }
                for r in reviews.get(stay.id, [])
            ]
            for stay in stays
        },
        "recommended_by_scoring": ranked[0].id if ranked else stays[0].id,
        "locale": "uk",
    }


def _texts(analysis: StayAnalysis) -> list[str]:
    return [
        analysis.top_pick_reason,
        analysis.price_vs_location_note,
        *(
            t
            for s in analysis.stays
            for t in (*s.pros, *s.cons, *s.red_flags, s.reliability_note, s.best_for)
        ),
    ]


def _problems(analysis: StayAnalysis, allowed: frozenset[str], recommended: str) -> list[str]:
    problems = []
    if analysis.top_pick_id != recommended:
        problems.append(
            f'top_pick_id має бути "{recommended}" — це вибір value-score, не переранжовуй.'
        )
    invented = {n for text in _texts(analysis) for n in numbers_in(text) if n not in allowed}
    if invented:
        problems.append(
            f"У відповіді є числа, яких немає у вхідних даних: {', '.join(sorted(invented))}. "
            "Використовуй лише готові значення й лічильники відгуків."
        )
    return problems


def _enforce_reliability(
    analysis: StayAnalysis, stays: Sequence[Stay], reviews: Mapping[str, list[StayReview]]
) -> StayAnalysis:
    by_id = {s.id: s for s in stays}
    fixed = []
    for insight in analysis.stays:
        stay = by_id[insight.id]
        few = (
            stay.review_count < MIN_RELIABLE_REVIEWS
            or len(reviews.get(stay.id, [])) < MIN_RELIABLE_REVIEWS
        )
        fixed.append(insight.model_copy(update={"reliability": "low"}) if few else insight)
    return analysis.model_copy(update={"stays": fixed})


def _parse(content: str, ids: set[str]) -> StayAnalysis | None:
    try:
        analysis = StayAnalysis.model_validate_json(content)
    except ValidationError as exc:
        log.warning("ai.stay_analysis.bad_model_output", errors=exc.error_count())
        return None
    if analysis.top_pick_id not in ids:
        log.warning("ai.stay_analysis.unknown_top_pick")
        return None
    analysis.stays = [s for s in analysis.stays if s.id in ids]
    return analysis
