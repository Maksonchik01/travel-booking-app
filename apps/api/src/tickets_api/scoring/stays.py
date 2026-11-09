"""Детермінований value-score житла і вибірка трьох варіантів. Чистий код: без I/O і без LLM.

Формула і ваги — у stays.toml (ADR 0008). Менша оцінка — вигідніше, як і для перельотів:
це ціна за ніч плюс «ціна» незручностей (далеко, без повернення коштів, слабкий рейтинг,
бракує бажаних зручностей). «Чому цей варіант?» — `reasons`: порівняння з найдешевшим і
найкраще оціненим у грошах за все проживання, кілометрах і балах рейтингу (ADR 0031).
"""

import tomllib
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal, Self, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tickets_api.domain.flights import Money
from tickets_api.domain.stays import Amenity, Number, Stay, StayPreferences, StayProfile

DEFAULT_STAY_CONFIG_PATH = Path(__file__).with_name("stays.toml")
CENT = Decimal("0.01")

StayPickLabel = Literal["cheapest", "top_rated", "balanced"]
StayWarningCode = Literal[
    "few_reviews",
    "no_rating",
    "distance_unknown",
    "transit_unknown",
    "cancellation_unknown",
]
StayReasonCode = Literal[
    "only_option",
    "cheapest",
    "top_rated",
    "best_balance",
    "pricier_but_closer",
    "pricier_but_better_rated",
    "cheaper_than_top_rated",
    "free_cancellation",
    "preferred_amenities",
    "within_budget",
]
# Меншу різницю не називаємо перевагою — це шум даних.
MIN_DISTANCE_GAIN_KM = Decimal("0.5")
MIN_RATING_GAIN = Decimal("0.3")
LABEL_PRECEDENCE: tuple[StayPickLabel, ...] = ("balanced", "cheapest", "top_rated")
DISPLAY_ORDER: tuple[StayPickLabel, ...] = ("cheapest", "balanced", "top_rated")


class _Strict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class StayProfileWeights(_Strict):
    lambda_distance_per_km: Decimal = Field(ge=0)
    lambda_rating_per_point: Decimal = Field(ge=0)


class StayPenalties(_Strict):
    transit_far: Decimal = Field(ge=0)
    non_refundable: Decimal = Field(ge=0)
    partial_refund: Decimal = Field(ge=0)
    missing_amenity: Decimal = Field(ge=0)


class StayThresholds(_Strict):
    free_radius_km: Decimal = Field(ge=0)
    transit_far_m: int = Field(gt=0)
    few_reviews: int = Field(ge=0)
    prior_rating: Decimal = Field(ge=0, le=10)
    prior_reviews: int = Field(ge=0)
    reference_rating: Decimal = Field(ge=0, le=10)


class StayScoringConfig(_Strict):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    profiles: dict[StayProfile, StayProfileWeights]
    penalties: StayPenalties
    thresholds: StayThresholds

    @model_validator(mode="after")
    def _all_profiles(self) -> Self:
        missing = set(get_args(StayProfile)) - set(self.profiles)
        if missing:
            raise ValueError(f"у конфігу бракує профілів: {sorted(missing)}")
        return self

    def in_currency(self, currency: str, rate: Decimal) -> "StayScoringConfig":
        """Ті самі ваги в іншій валюті (як ScoringConfig.in_currency, модуль 18.2): гроші ×
        курс; кілометри, метри й бали — як є."""
        if currency == self.currency:
            return self
        return self.model_copy(
            update={
                "currency": currency,
                "profiles": {
                    name: StayProfileWeights(
                        lambda_distance_per_km=w.lambda_distance_per_km * rate,
                        lambda_rating_per_point=w.lambda_rating_per_point * rate,
                    )
                    for name, w in self.profiles.items()
                },
                "penalties": StayPenalties(
                    **{k: v * rate for k, v in self.penalties.model_dump().items()}
                ),
            }
        )


def load_stay_scoring_config(path: Path) -> StayScoringConfig:
    with path.open("rb") as f:
        return StayScoringConfig.model_validate(tomllib.load(f, parse_float=Decimal))


@lru_cache
def default_stay_scoring_config() -> StayScoringConfig:
    return load_stay_scoring_config(DEFAULT_STAY_CONFIG_PATH)


class StayScoreBreakdown(BaseModel):
    price: Money
    """Ціна за ніч з податками."""
    distance_penalty: Money
    transit_penalty: Money
    rating_penalty: Money
    cancellation_penalty: Money
    amenity_penalty: Money = Decimal(0)
    missing_amenities: list[Amenity] = []
    """Бажані зручності з профілю, яких у об'єкта немає."""
    adjusted_rating: Number | None
    """Рейтинг з поправкою на кількість відгуків; None — оцінок немає."""
    total: Money


class StayReason(BaseModel):
    """Причина «Чому цей варіант?» — факт з даних пошуку. Гроші — за все проживання."""

    code: StayReasonCode
    vs: StayPickLabel | None = None
    amount: Money | None = None
    km: Number | None = None
    rating: Number | None = None
    count: int | None = None


class StayWarning(BaseModel):
    code: StayWarningCode


class StayScore(BaseModel):
    stay_key: str
    breakdown: StayScoreBreakdown
    warnings: list[StayWarning]
    pareto_optimal: bool
    reasons: list[StayReason] = []


class StayPick(BaseModel):
    label: StayPickLabel
    stay_key: str
    also: list[StayPickLabel] = []


class StayScoringResult(BaseModel):
    profile: StayProfile
    currency: str
    scores: list[StayScore]
    picks: list[StayPick]
    unscored_stay_keys: list[str] = []


def stay_key(stay: Stay) -> str:
    return f"{stay.source}:{stay.id}"


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def adjusted_rating(stay: Stay, config: StayScoringConfig) -> Decimal | None:
    if stay.rating is None:
        return None
    t = config.thresholds
    n = Decimal(stay.review_count)
    m = Decimal(t.prior_reviews)
    if n + m == 0:
        return stay.rating
    return ((n * stay.rating + m * t.prior_rating) / (n + m)).quantize(Decimal("0.01"))


def score_stay(
    stay: Stay,
    profile: StayProfile,
    config: StayScoringConfig,
    preferences: StayPreferences | None = None,
) -> StayScore:
    weights = config.profiles[profile]
    t, p = config.thresholds, config.penalties
    warnings: list[StayWarning] = []

    distance_penalty = Decimal(0)
    if stay.distance_to_center_km is None:
        warnings.append(StayWarning(code="distance_unknown"))
    else:
        extra_km = max(Decimal(0), stay.distance_to_center_km - t.free_radius_km)
        distance_penalty = weights.lambda_distance_per_km * extra_km

    transit_penalty = Decimal(0)
    if stay.distance_to_transit_m is None:
        warnings.append(StayWarning(code="transit_unknown"))
    elif stay.distance_to_transit_m > t.transit_far_m:
        transit_penalty = p.transit_far

    rating = adjusted_rating(stay, config)
    rating_penalty = Decimal(0)
    if rating is None:
        warnings.append(StayWarning(code="no_rating"))
        # Без оцінок — як «середній» об'єкт: не карати сильніше за погані відгуки.
        rating_penalty = weights.lambda_rating_per_point * max(
            Decimal(0), t.reference_rating - t.prior_rating
        )
    else:
        rating_penalty = weights.lambda_rating_per_point * max(
            Decimal(0), t.reference_rating - rating
        )
        if stay.review_count < t.few_reviews:
            warnings.append(StayWarning(code="few_reviews"))

    cancellation_penalty = Decimal(0)
    if stay.cancellation is None:
        warnings.append(StayWarning(code="cancellation_unknown"))
    elif stay.cancellation == "non_refundable":
        cancellation_penalty = p.non_refundable
    elif stay.cancellation == "partial":
        cancellation_penalty = p.partial_refund

    # Порожній список зручностей — джерело їх не дало: невідомо, не «немає» (ADR 0004).
    wanted = preferences.amenities if preferences else []
    missing = [a for a in wanted if stay.amenities and a not in stay.amenities]
    amenity_penalty = p.missing_amenity * len(missing)

    price = _money(stay.price_per_night)
    total = (
        price
        + distance_penalty
        + transit_penalty
        + rating_penalty
        + cancellation_penalty
        + amenity_penalty
    )
    return StayScore(
        stay_key=stay_key(stay),
        breakdown=StayScoreBreakdown(
            price=price,
            distance_penalty=_money(distance_penalty),
            transit_penalty=_money(transit_penalty),
            rating_penalty=_money(rating_penalty),
            cancellation_penalty=_money(cancellation_penalty),
            amenity_penalty=_money(amenity_penalty),
            missing_amenities=missing,
            adjusted_rating=rating,
            total=_money(total),
        ),
        warnings=warnings,
        pareto_optimal=False,
    )


def score_stays(
    stays: Sequence[Stay],
    profile: StayProfile,
    config: StayScoringConfig,
    *,
    preferences: StayPreferences | None = None,
    budget: Decimal | None = None,
) -> StayScoringResult:
    """`budget` — ліміт на все проживання з фільтрів (уже застосованих): лише для причини
    «у межах бюджету, запас N»."""
    comparable = [s for s in stays if s.currency == config.currency]
    unscored = [stay_key(s) for s in stays if s.currency != config.currency]
    scores = [score_stay(s, profile, config, preferences) for s in comparable]
    by_key = {stay_key(s): s for s in comparable}
    scores = _mark_pareto(scores, by_key)
    picks = _picks(scores)
    return StayScoringResult(
        profile=profile,
        currency=config.currency,
        scores=_with_reasons(scores, picks, by_key, preferences, budget),
        picks=picks,
        unscored_stay_keys=unscored,
    )


def _axes(score: StayScore, stay: Stay) -> tuple[Decimal, Decimal, Decimal]:
    """Менше — краще за кожною віссю: ціна, (мінус) рейтинг, відстань."""
    rating = score.breakdown.adjusted_rating
    distance = stay.distance_to_center_km
    return (
        score.breakdown.price,
        -(rating if rating is not None else Decimal(0)),
        distance if distance is not None else Decimal("Infinity"),
    )


def _mark_pareto(scores: list[StayScore], by_key: dict[str, Stay]) -> list[StayScore]:
    axes = {s.stay_key: _axes(s, by_key[s.stay_key]) for s in scores}

    def dominated(key: str) -> bool:
        mine = axes[key]
        return any(
            other != mine and all(o <= m for o, m in zip(other, mine, strict=True))
            for k, other in axes.items()
            if k != key
        )

    return [s.model_copy(update={"pareto_optimal": not dominated(s.stay_key)}) for s in scores]


def _picks(scores: list[StayScore]) -> list[StayPick]:
    if not scores:
        return []

    def rating(s: StayScore) -> Decimal:
        r = s.breakdown.adjusted_rating
        return r if r is not None else Decimal(-1)

    winners: dict[StayPickLabel, str] = {
        "cheapest": min(scores, key=lambda s: (s.breakdown.price, s.breakdown.total)).stay_key,
        "top_rated": max(scores, key=lambda s: (rating(s), -s.breakdown.price)).stay_key,
        "balanced": min(scores, key=lambda s: (s.breakdown.total, s.breakdown.price)).stay_key,
    }
    picks: dict[str, StayPick] = {}
    for label in LABEL_PRECEDENCE:
        key = winners[label]
        if key in picks:
            picks[key].also.append(label)
        else:
            picks[key] = StayPick(label=label, stay_key=key)
    order = {label: i for i, label in enumerate(DISPLAY_ORDER)}
    return sorted(picks.values(), key=lambda p: order[p.label])


def _with_reasons(
    scores: list[StayScore],
    picks: list[StayPick],
    by_key: dict[str, Stay],
    preferences: StayPreferences | None,
    budget: Decimal | None,
) -> list[StayScore]:
    """«Чому цей варіант?»: що виграв і чим відрізняється від найдешевшого (дорожче, але
    ближче / краще оцінений) та найкраще оціненого (дешевше) — з тих самих даних."""
    winners = {label: p.stay_key for p in picks for label in (p.label, *p.also)}
    rated = {s.stay_key: s.breakdown.adjusted_rating for s in scores}
    cheapest = by_key.get(winners.get("cheapest", ""))
    top = by_key.get(winners.get("top_rated", ""))
    wanted = preferences.amenities if preferences else []
    result = []
    for score in scores:
        key = score.stay_key
        stay = by_key[key]
        reasons: list[StayReason] = []
        if len(scores) == 1:
            reasons.append(StayReason(code="only_option"))
        else:
            if winners.get("cheapest") == key:
                reasons.append(StayReason(code="cheapest", count=len(scores)))
            if winners.get("top_rated") == key:
                reasons.append(StayReason(code="top_rated", count=len(scores)))
            if winners.get("balanced") == key:
                reasons.append(StayReason(code="best_balance", amount=score.breakdown.total))
        mine = rated[key]
        if cheapest is not None and cheapest is not stay:
            extra = _money(max(stay.total_price - cheapest.total_price, Decimal(0)))
            near, far = stay.distance_to_center_km, cheapest.distance_to_center_km
            if near is not None and far is not None and far - near >= MIN_DISTANCE_GAIN_KM:
                reasons.append(
                    StayReason(
                        code="pricier_but_closer", vs="cheapest", amount=extra, km=far - near
                    )
                )
            base = rated[stay_key(cheapest)]
            if mine is not None and base is not None and mine - base >= MIN_RATING_GAIN:
                reasons.append(
                    StayReason(
                        code="pricier_but_better_rated",
                        vs="cheapest",
                        amount=extra,
                        rating=mine - base,
                    )
                )
            if stay.cancellation == "free" and cheapest.cancellation in (
                "non_refundable",
                "partial",
            ):
                reasons.append(StayReason(code="free_cancellation", vs="cheapest"))
        if top is not None and top is not stay and stay.total_price < top.total_price:
            best = rated[stay_key(top)]
            reasons.append(
                StayReason(
                    code="cheaper_than_top_rated",
                    vs="top_rated",
                    amount=_money(top.total_price - stay.total_price),
                    rating=best - mine if best is not None and mine is not None else None,
                )
            )
        if wanted and stay.amenities and all(a in stay.amenities for a in wanted):
            reasons.append(StayReason(code="preferred_amenities", count=len(wanted)))
        if budget is not None and stay.total_price <= budget:
            reasons.append(
                StayReason(code="within_budget", amount=_money(budget - stay.total_price))
            )
        result.append(score.model_copy(update={"reasons": reasons}))
    return result
