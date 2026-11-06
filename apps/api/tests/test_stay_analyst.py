import json
from datetime import UTC, date, datetime
from typing import Any

from tickets_api.ai.evaluation import ReplayClient
from tickets_api.ai.stay_analyst import StayAnalyst, analyst_input
from tickets_api.domain.stays import Stay, StayQuery, StayReview
from tickets_api.llm.types import ChatRequest, ChatResponse
from tickets_api.providers.mock_stays import INJECTION, MockStayProvider
from tickets_api.reference.airports import default_airport_directory
from tickets_api.scoring.stays import StayScore, default_stay_scoring_config, score_stays

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
QUERY = StayQuery(city="LIS", check_in=date(2026, 12, 5), check_out=date(2026, 12, 8))


async def inputs() -> tuple[list[Stay], dict[str, StayScore], dict[str, list[StayReview]]]:
    provider = MockStayProvider(default_airport_directory(), clock=lambda: NOW)
    stays = (await provider.search(QUERY))[2:5]  # mock-lis-2..4, серед них — з ін'єкцією
    result = score_stays(stays, "balanced", default_stay_scoring_config())
    scores = {s.stay_key.split(":", 1)[1]: s for s in result.scores}
    reviews = {s.id: await provider.reviews(s.id) for s in stays}
    return stays, scores, reviews


def answer(top: str, ids: list[str], **extra: Any) -> ChatResponse:
    body = {
        "stays": [{"id": i, "pros": ["Привітний персонал."], "reliability": "high"} for i in ids],
        "top_pick_id": top,
        "top_pick_reason": "Найкраще поєднання ціни й розташування.",
        **extra,
    }
    return ChatResponse(model="m", content=json.dumps(body, ensure_ascii=False))


async def test_input_follows_owner_prompt_format() -> None:
    stays, scores, reviews = await inputs()

    payload = analyst_input(QUERY, stays, scores, reviews, now=NOW)

    item = payload["stays"][0]
    for field in ("id", "name", "price_per_night_text", "rating_text", "review_count",
                  "distance_to_center_text", "cancellation_policy", "amenities",
                  "value_score", "score_breakdown", "reviews_in_sample"):  # fmt: skip
        assert field in item
    assert payload["query"]["nights"] == 3
    # Відгук з ін'єкцією передається як ДАНІ в полі reviews, а не як інструкція.
    texts = [r["text"] for rs in payload["reviews"].values() for r in rs]
    assert INJECTION in texts
    assert payload["recommended_by_scoring"] in {s.id for s in stays}


async def test_ok_and_low_reliability_is_enforced_for_few_reviews() -> None:
    stays, scores, reviews = await inputs()
    ids = [s.id for s in stays]
    recommended = analyst_input(QUERY, stays, scores, reviews, now=NOW)["recommended_by_scoring"]

    result = await StayAnalyst(model="pro").analyze(
        QUERY, stays, scores, reviews, ReplayClient([answer(recommended, ids)]), now=NOW
    )

    assert result.status == "ok"
    assert result.analysis is not None
    by_id = {s.id: s for s in stays}
    for insight in result.analysis.stays:
        few = by_id[insight.id].review_count < 10 or len(reviews[insight.id]) < 10
        assert insight.reliability == ("low" if few else "high")


async def test_review_counts_are_allowed_invented_prices_are_not() -> None:
    stays, scores, reviews = await inputs()
    ids = [s.id for s in stays]
    recommended = analyst_input(QUERY, stays, scores, reviews, now=NOW)["recommended_by_scoring"]
    sample = len(reviews[ids[0]])
    counted = answer(recommended, ids, price_vs_location_note=f"Про шум пишуть 2 з {sample}.")
    invented = answer(recommended, ids, price_vs_location_note="Насправді коштує 999 EUR.")
    sent: list[ChatRequest] = []
    client = ReplayClient([invented, counted])
    original = client.chat

    async def spy(request: ChatRequest) -> ChatResponse:
        sent.append(request)
        return await original(request)

    client.chat = spy  # type: ignore[method-assign]

    result = await StayAnalyst(model="pro").analyze(QUERY, stays, scores, reviews, client, now=NOW)

    assert result.status == "ok"
    assert "999" in sent[-1].messages[-1].content


async def test_reranking_by_model_is_rejected_after_retry() -> None:
    stays, scores, reviews = await inputs()
    ids = [s.id for s in stays]
    recommended = analyst_input(QUERY, stays, scores, reviews, now=NOW)["recommended_by_scoring"]
    other = next(i for i in ids if i != recommended)

    result = await StayAnalyst(model="pro").analyze(
        QUERY,
        stays,
        scores,
        reviews,
        ReplayClient([answer(other, ids), answer(other, ids)]),
        now=NOW,
    )

    assert result.status == "rejected"
