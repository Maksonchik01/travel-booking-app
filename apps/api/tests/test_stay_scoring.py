from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from tickets_api.domain.stays import Stay
from tickets_api.scoring.stays import (
    adjusted_rating,
    default_stay_scoring_config,
    score_stay,
    score_stays,
)

CONFIG = default_stay_scoring_config()
NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)


def stay(stay_id: str, **fields: Any) -> Stay:
    data: dict[str, Any] = {
        "id": stay_id,
        "source": "t",
        "name": f"Stay {stay_id}",
        "kind": "hotel",
        "price_per_night": Decimal(100),
        "total_price": Decimal(300),
        "currency": "EUR",
        "nights": 3,
        "rating": Decimal("9.0"),
        "review_count": 1000,
        "distance_to_center_km": Decimal("0.5"),
        "distance_to_transit_m": 200,
        "cancellation": "free",
        "collected_at": NOW,
    }
    data.update(fields)
    return Stay.model_validate(data)


def test_ideal_stay_costs_just_its_price() -> None:
    # Поруч з центром, транспорт близько, 9,0 з тисячі відгуків, безкоштовне скасування.
    score = score_stay(stay("a"), "balanced", CONFIG)

    b = score.breakdown
    assert b.distance_penalty == b.transit_penalty == b.cancellation_penalty == Decimal(0)
    # Скоригований рейтинг трохи нижчий за 9,0 (prior 7,5 з вагою 20 відгуків).
    assert b.adjusted_rating == Decimal("8.97")
    assert b.rating_penalty == Decimal("0.45")
    assert b.total == Decimal("100.45")
    assert score.warnings == []


def test_formula_parts_for_balanced_profile() -> None:
    far = stay(
        "b",
        distance_to_center_km=Decimal("4.0"),
        distance_to_transit_m=1200,
        cancellation="non_refundable",
        rating=Decimal("8.0"),
        review_count=380,
    )

    b = score_stay(far, "balanced", CONFIG).breakdown

    assert b.distance_penalty == Decimal("24.00")  # 8 €/км × (4 − 1 км безкоштовно)
    assert b.transit_penalty == Decimal("8.00")
    assert b.cancellation_penalty == Decimal("15.00")
    assert b.adjusted_rating == Decimal("7.98")  # (380·8 + 20·7,5) / 400 ≈ 7,975
    assert b.rating_penalty == Decimal("15.30")  # 15 €/бал × (9 − 7,98)
    assert b.total == Decimal("162.30")


def test_few_reviews_do_not_beat_many() -> None:
    lucky = stay("lucky", rating=Decimal("9.8"), review_count=4)
    proven = stay("proven", rating=Decimal("9.1"), review_count=1200)

    assert adjusted_rating(lucky, CONFIG) < adjusted_rating(proven, CONFIG)  # type: ignore[operator]
    warnings = [w.code for w in score_stay(lucky, "balanced", CONFIG).warnings]
    assert warnings == ["few_reviews"]


def test_unknown_details_are_warnings_without_penalty() -> None:
    unknown = stay("u", distance_to_center_km=None, distance_to_transit_m=None, cancellation=None)

    score = score_stay(unknown, "balanced", CONFIG)

    b = score.breakdown
    assert b.distance_penalty == b.transit_penalty == b.cancellation_penalty == Decimal(0)
    assert [w.code for w in score.warnings] == [
        "distance_unknown",
        "transit_unknown",
        "cancellation_unknown",
    ]


def test_center_profile_values_distance_more() -> None:
    far = stay("far", distance_to_center_km=Decimal("5.0"))

    budget = score_stay(far, "budget", CONFIG).breakdown.distance_penalty
    center = score_stay(far, "center", CONFIG).breakdown.distance_penalty

    assert (budget, center) == (Decimal("12.00"), Decimal("80.00"))


def test_three_picks_and_pareto() -> None:
    cheap_far = stay(
        "cheap", price_per_night=Decimal(60), distance_to_center_km=Decimal("6"), rating=Decimal(7)
    )
    best_rated = stay("rated", price_per_night=Decimal(180), rating=Decimal("9.6"))
    balanced = stay("bal", price_per_night=Decimal(95), rating=Decimal("8.8"))
    dominated = stay("dom", price_per_night=Decimal(200), rating=Decimal("8.0"))

    result = score_stays([cheap_far, best_rated, balanced, dominated], "balanced", CONFIG)

    assert [(p.label, p.stay_key) for p in result.picks] == [
        ("cheapest", "t:cheap"),
        ("balanced", "t:bal"),
        ("top_rated", "t:rated"),
    ]
    pareto = {s.stay_key for s in result.scores if s.pareto_optimal}
    assert "t:dom" not in pareto
    assert {"t:cheap", "t:bal", "t:rated"} <= pareto


def test_other_currency_is_not_scored() -> None:
    result = score_stays([stay("a"), stay("b", currency="PLN")], "balanced", CONFIG)

    assert result.unscored_stay_keys == ["t:b"]
    assert [s.stay_key for s in result.scores] == ["t:a"]
