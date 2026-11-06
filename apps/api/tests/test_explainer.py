import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from flight_fakes import StubProvider, offers_for
from tickets_api.ai.evaluation import ReplayClient
from tickets_api.ai.explainer import (
    Explanation,
    FlightExplainer,
    advisor_input,
    allowed_numbers,
    invented_numbers,
)
from tickets_api.domain.flights import FlightQuery
from tickets_api.llm.types import ChatResponse
from tickets_api.repositories.price_history import PriceStats
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchResult, FlightSearchService

QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))
NOW = datetime(2026, 11, 4, 12, tzinfo=UTC)


async def search_result() -> FlightSearchResult:
    cheap, slow_expensive = offers_for("a", [88, 152])
    slow_expensive = slow_expensive.model_copy(
        update={"outbound": slow_expensive.outbound.model_copy(update={"duration_min": 270})}
    )
    svc = FlightSearchService(
        [StubProvider("a", offers=[cheap, slow_expensive])],
        timeout_s=1,
        scoring_config=default_scoring_config(),
    )
    return await svc.search(QUERY)


# Дешевший варіант ще й швидший — тож він «balanced» (also: cheapest, fastest).
def answer(summary: str, recommended: str = "balanced", **extra: Any) -> ChatResponse:
    body = {"summary": summary, "recommended_id": recommended, "options": [], **extra}
    return ChatResponse(model="m", content=json.dumps(body, ensure_ascii=False))


async def test_input_has_ready_made_differences_and_no_thin_history() -> None:
    result = await search_result()
    thin = PriceStats(
        median=Decimal(100),
        p25=Decimal(90),
        p75=Decimal(120),
        percentile_of_best_offer=10,
        sample_size=5,
        days_covered=3,
        currency="EUR",
    )

    payload = advisor_input(QUERY, result, now=NOW, price_stats=thin)

    [option] = payload["options"]
    assert (option["id"], option["title"]) == ("balanced", "Збалансований")
    assert option["also"] == ["Найдешевший", "Найшвидший"]
    assert option["price_text"] == "88 EUR"
    assert option["duration_text"] == "4 год"
    assert payload["price_stats"] is None  # sample_size < 20 — не оцінюємо за історією
    assert payload["forecast"] is None


def test_number_guard() -> None:
    allowed = allowed_numbers({"price_text": "88 EUR", "duration_text": "4 год 05 хв"})
    ok = Explanation(summary="Варіант за 88 EUR, 4 год 5 хв, 2 пересадки", recommended_id="x")
    bad = Explanation(summary="На 64 EUR дешевше, економія 12,5%", recommended_id="x")

    assert invented_numbers(ok, allowed) == set()
    assert invented_numbers(bad, allowed) == {"64", "12.5"}


async def test_invented_numbers_get_one_retry_then_rejected() -> None:
    result = await search_result()
    explainer = FlightExplainer(model="deepseek-v4-pro")
    good = answer("Найдешевший — 88 EUR.")
    invented = answer("Дешевше на 999 EUR.")

    fixed = await explainer.explain(QUERY, result, ReplayClient([invented, good]), now=NOW)
    rejected = await explainer.explain(QUERY, result, ReplayClient([invented, invented]), now=NOW)

    assert fixed.status == "ok"
    assert fixed.explanation is not None
    assert fixed.explanation.summary == "Найдешевший — 88 EUR."
    assert rejected.status == "rejected"


async def test_unknown_recommendation_and_extra_options_are_dropped() -> None:
    result = await search_result()
    explainer = FlightExplainer(model="m")
    unknown = answer("ok", recommended="hotel-ad")
    extra = answer(
        "ok",
        options=[{"id": "balanced", "one_liner": "так"}, {"id": "sponsored", "one_liner": "ні"}],
    )

    assert (await explainer.explain(QUERY, result, ReplayClient([unknown]), now=NOW)).status == (
        "rejected"
    )
    ok = await explainer.explain(QUERY, result, ReplayClient([extra]), now=NOW)
    assert ok.explanation is not None
    assert [o.id for o in ok.explanation.options] == ["balanced"]


async def test_reranking_by_model_gets_one_retry() -> None:
    cheap, fast = offers_for("a", [53, 86])
    cheap = cheap.model_copy(
        update={"outbound": cheap.outbound.model_copy(update={"duration_min": 300})}
    )
    svc = FlightSearchService(
        [StubProvider("a", offers=[cheap, fast])],
        timeout_s=1,
        scoring_config=default_scoring_config(),
    )
    result = await svc.search(QUERY)
    payload = advisor_input(QUERY, result, now=NOW, price_stats=None)
    assert payload["recommended_by_scoring"] == "balanced"
    explainer = FlightExplainer(model="m")
    rerank = answer("ok", recommended="fastest")

    fixed = await explainer.explain(QUERY, result, ReplayClient([rerank, answer("ok")]), now=NOW)
    stubborn = await explainer.explain(QUERY, result, ReplayClient([rerank, rerank]), now=NOW)

    assert fixed.status == "ok"
    assert stubborn.status == "rejected"
