"""Детермінований скоринг перельотів і Pareto-вибірка. Чистий код: без I/O і без LLM.

    cost = price + λ_time · (total_hours − min_hours) + λ_stop · stops + штрафи ризику

`min_hours` — найкоротший відомий час у дорозі серед оцінених пропозицій, тож найшвидший
варіант штрафу за час не має. Багаж у вартість не входить; умови багажу і невідомі
деталі пересадок — лише попередження (рішення власника продукту, ADR 0005).
"""

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import Leg, Money, Offer
from tickets_api.scoring.config import Profile, ScoringConfig

PickLabel = Literal["cheapest", "fastest", "balanced"]
RiskCode = Literal["short_layover", "overnight_layover", "self_transfer", "night_departure"]
WarningCode = Literal[
    "layover_details_unknown",
    "long_layover",
    "baggage_not_included",
    "baggage_unknown",
    "duration_unknown",
]
LegName = Literal["outbound", "inbound"]

CENT = Decimal("0.01")
MINUTES_PER_HOUR = Decimal(60)
# Якщо одна пропозиція виграє кілька номінацій, показуємо її під найважливішою.
LABEL_PRECEDENCE: tuple[PickLabel, ...] = ("balanced", "cheapest", "fastest")
DISPLAY_ORDER: tuple[PickLabel, ...] = ("cheapest", "balanced", "fastest")


class RiskPenalty(BaseModel):
    code: RiskCode
    leg: LegName
    amount: Money
    airport: str | None = None
    """Аеропорт пересадки (для штрафів за пересадку) або вильоту (для нічного вильоту)."""


class ScoreWarning(BaseModel):
    code: WarningCode
    leg: LegName | None = None
    airport: str | None = None


class ScoreBreakdown(BaseModel):
    price: Money
    time_penalty: Money | None
    """None — тривалість невідома, тож узагальнену вартість не порахувати."""
    stop_penalty: Money
    risk_penalties: list[RiskPenalty]
    risk_total: Money
    total: Money | None


class OfferScore(BaseModel):
    offer_key: str
    breakdown: ScoreBreakdown
    warnings: list[ScoreWarning]
    pareto_optimal: bool


class Pick(BaseModel):
    label: PickLabel
    offer_key: str
    also: list[PickLabel] = []
    """Інші номінації, які виграла ця ж пропозиція."""


class ScoringResult(BaseModel):
    profile: Profile
    currency: str
    min_duration_min: int | None
    scores: list[OfferScore]
    picks: list[Pick]
    unscored_offer_keys: list[str] = []
    """Пропозиції в іншій валюті, ніж валюта скорингу: їх не порівнюємо."""


def offer_key(offer: Offer) -> str:
    return f"{offer.source}:{offer.id}"


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def score_offers(offers: Sequence[Offer], profile: Profile, config: ScoringConfig) -> ScoringResult:
    comparable = [o for o in offers if o.currency == config.currency]
    unscored = [offer_key(o) for o in offers if o.currency != config.currency]
    durations = [o.total_duration_min for o in comparable if o.total_duration_min is not None]
    min_duration = min(durations, default=None)

    weights = config.profiles[profile]
    pareto = _pareto_keys(comparable)
    scores = []
    for offer in comparable:
        penalties, warnings = _risks(offer, config)
        risk_total = sum((p.amount for p in penalties), Decimal(0))
        stop_penalty = _money(weights.lambda_stop * offer.stops)
        time_penalty: Decimal | None = None
        total: Decimal | None = None
        if offer.total_duration_min is not None and min_duration is not None:
            extra_hours = Decimal(offer.total_duration_min - min_duration) / MINUTES_PER_HOUR
            time_penalty = _money(weights.lambda_time_per_hour * extra_hours)
            total = _money(offer.price + time_penalty + stop_penalty + risk_total)
        scores.append(
            OfferScore(
                offer_key=offer_key(offer),
                breakdown=ScoreBreakdown(
                    price=offer.price,
                    time_penalty=time_penalty,
                    stop_penalty=stop_penalty,
                    risk_penalties=penalties,
                    risk_total=_money(risk_total),
                    total=total,
                ),
                warnings=warnings,
                pareto_optimal=offer_key(offer) in pareto,
            )
        )

    return ScoringResult(
        profile=profile,
        currency=config.currency,
        min_duration_min=min_duration,
        scores=scores,
        picks=_picks(comparable, {s.offer_key: s for s in scores}),
        unscored_offer_keys=unscored,
    )


def _risks(offer: Offer, config: ScoringConfig) -> tuple[list[RiskPenalty], list[ScoreWarning]]:
    penalties: list[RiskPenalty] = []
    warnings: list[ScoreWarning] = []
    legs: list[tuple[LegName, Leg]] = [("outbound", offer.outbound)]
    if offer.inbound is not None:
        legs.append(("inbound", offer.inbound))

    th, pen = config.thresholds, config.penalties
    for name, leg in legs:
        # Час вильоту — місцевий для аеропорту (ISO з поясом від провайдера).
        if th.night_start_hour <= leg.departure_at.hour < th.night_end_hour:
            penalties.append(
                RiskPenalty(
                    code="night_departure",
                    leg=name,
                    amount=pen.night_departure,
                    airport=leg.origin,
                )
            )
        if leg.stops > 0 and leg.layovers is None:
            warnings.append(ScoreWarning(code="layover_details_unknown", leg=name))
        for layover in leg.layovers or []:
            checks: list[tuple[bool, RiskCode, Decimal]] = [
                (layover.duration_min < th.short_layover_min, "short_layover", pen.short_layover),
                (layover.overnight, "overnight_layover", pen.overnight_layover),
                (layover.self_transfer is True, "self_transfer", pen.self_transfer),
            ]
            for applies, code, amount in checks:
                if applies:
                    penalties.append(
                        RiskPenalty(code=code, leg=name, amount=amount, airport=layover.airport)
                    )
            if layover.duration_min > th.long_layover_min:
                warnings.append(
                    ScoreWarning(code="long_layover", leg=name, airport=layover.airport)
                )

    if offer.baggage_included is False:
        warnings.append(ScoreWarning(code="baggage_not_included"))
    elif offer.baggage_included is None:
        warnings.append(ScoreWarning(code="baggage_unknown"))
    if offer.total_duration_min is None:
        warnings.append(ScoreWarning(code="duration_unknown"))
    return penalties, warnings


def _pareto_keys(offers: Sequence[Offer]) -> set[str]:
    """Недоміновані за (ціна, тривалість, пересадки). Невідома тривалість — поза множиною."""
    known = [o for o in offers if o.total_duration_min is not None]

    def objectives(o: Offer) -> tuple[Decimal, Decimal, Decimal]:
        return o.price, Decimal(o.total_duration_min or 0), Decimal(o.stops)

    def dominates(a: Offer, b: Offer) -> bool:
        oa, ob = objectives(a), objectives(b)
        return all(x <= y for x, y in zip(oa, ob, strict=True)) and oa != ob

    return {offer_key(o) for o in known if not any(dominates(other, o) for other in known)}


def _picks(offers: Sequence[Offer], scores: dict[str, OfferScore]) -> list[Pick]:
    if not offers:
        return []
    winners: dict[PickLabel, str] = {}

    # Найдешевший — серед усіх (тривалість для нього не потрібна).
    cheapest = min(offers, key=lambda o: (o.price, o.stops, offer_key(o)))
    winners["cheapest"] = offer_key(cheapest)

    timed = [o for o in offers if o.total_duration_min is not None]
    if timed:
        fastest = min(timed, key=lambda o: (o.total_duration_min, o.price, o.stops, offer_key(o)))
        winners["fastest"] = offer_key(fastest)

        # Збалансований — мінімальна узагальнена вартість серед Pareto-оптимальних.
        frontier = [o for o in timed if scores[offer_key(o)].pareto_optimal]

        def cost(o: Offer) -> tuple[Decimal, Decimal, str]:
            total = scores[offer_key(o)].breakdown.total
            return (total if total is not None else Decimal("Infinity"), o.price, offer_key(o))

        winners["balanced"] = offer_key(min(frontier, key=cost))

    by_offer: dict[str, list[PickLabel]] = {}
    for label in LABEL_PRECEDENCE:
        if label in winners:
            by_offer.setdefault(winners[label], []).append(label)

    picks = [
        Pick(label=labels[0], offer_key=key, also=labels[1:]) for key, labels in by_offer.items()
    ]
    return sorted(picks, key=lambda p: DISPLAY_ORDER.index(p.label))
