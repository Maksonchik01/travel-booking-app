"""Детермінований скоринг перельотів і Pareto-вибірка. Чистий код: без I/O і без LLM.

    cost = price + доплата за багаж + λ_time · (total_hours − min_hours) + λ_stop · stops
         + штрафи ризику + штрафи за уподобання

`min_hours` — найкоротший відомий час у дорозі серед оцінених пропозицій, тож найшвидший
варіант штрафу за час не має. Багаж — лише відома доплата за обраний у пошуку (ADR 0031);
невідомі умови багажу й деталі пересадок — лише попередження (ADR 0005).

Скоринг ранжує лише те, що вже пройшло обов'язкові вимоги (фільтри, «лише прямі», багаж):
їх відсікає сервіс до оцінки (модуль 14.1). «Чому цей варіант?» — `reasons`: порівняння з
найдешевшим і найшвидшим у числах з цих самих даних, без LLM.
"""

from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal
from itertools import pairwise
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import (
    DEPARTURE_PERIOD_HOURS,
    FlightPreferences,
    Leg,
    Money,
    Offer,
    _in_hours,
)
from tickets_api.scoring.baggage import BaggageCost
from tickets_api.scoring.config import Profile, ScoringConfig

PickLabel = Literal["cheapest", "fastest", "balanced"]
RiskCode = Literal[
    "short_layover",
    "overnight_layover",
    "self_transfer",
    "night_departure",
    "night_arrival",
    "airport_change",
]
PreferenceMiss = Literal["airline", "departure_time"]
ReasonCode = Literal[
    "only_option",
    "cheapest",
    "fastest",
    "best_balance",
    "pricier_but_faster",
    "cheaper_but_slower",
    "fewer_stops",
    "avoids_risk",
    "baggage_included",
    "preferred_airline",
    "preferred_time",
]
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
# Різниця в часі, меншу за цю, не називаємо «економією» — це шум розкладу.
MIN_TIME_GAIN_MIN = 30
# Якщо одна пропозиція виграє кілька номінацій, показуємо її під найважливішою.
LABEL_PRECEDENCE: tuple[PickLabel, ...] = ("balanced", "cheapest", "fastest")
DISPLAY_ORDER: tuple[PickLabel, ...] = ("cheapest", "balanced", "fastest")


class RiskPenalty(BaseModel):
    code: RiskCode
    leg: LegName
    amount: Money
    airport: str | None = None
    """Аеропорт пересадки, вильоту (нічний виліт) чи прильоту (нічний приліт); зміна
    аеропорту — «LGW→STN»."""


class ScoreWarning(BaseModel):
    code: WarningCode
    leg: LegName | None = None
    airport: str | None = None


class ScoreBreakdown(BaseModel):
    price: Money
    baggage_extra: Money | None = None
    """Відома доплата за обраний у пошуку багаж (входить у total); None — багаж не потрібен
    або доплата невідома (тоді — попередження, без штрафу)."""
    time_penalty: Money | None
    """None — тривалість невідома, тож узагальнену вартість не порахувати."""
    stop_penalty: Money
    risk_penalties: list[RiskPenalty]
    risk_total: Money
    preference_penalty: Money = Decimal(0)
    preference_misses: list[PreferenceMiss] = []
    """Які особисті уподобання з профілю пропозиція не виконує."""
    total: Money | None


class Reason(BaseModel):
    """Одна конкретна причина «Чому цей варіант?» — факт із даних пошуку, не оцінка LLM.

    Суми — у валюті скорингу, різниця за абсолютним значенням; `vs` — з чим порівнюємо."""

    code: ReasonCode
    vs: PickLabel | None = None
    amount: Money | None = None
    minutes: int | None = None
    count: int | None = None
    risk: RiskCode | None = None


class OfferScore(BaseModel):
    offer_key: str
    breakdown: ScoreBreakdown
    warnings: list[ScoreWarning]
    pareto_optimal: bool
    reasons: list[Reason] = []


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
    cheapest_basis: Literal["ticket", "with_baggage"] = "ticket"
    """with_baggage — «найдешевший» обрано за кінцевою вартістю з потрібним багажем (ADR 0014)."""


def offer_key(offer: Offer) -> str:
    return f"{offer.source}:{offer.id}"


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def score_offers(
    offers: Sequence[Offer],
    profile: Profile,
    config: ScoringConfig,
    *,
    travellers: int = 1,
    baggage: Mapping[str, BaggageCost] | None = None,
    preferences: FlightPreferences | None = None,
) -> ScoringResult:
    """`travellers` — скільки людей сидить у кріслах (ADR 0013): ціна вже за всіх, тож і
    вартість зайвого часу, пересадок і ризиків множимо на них — для 1 людини як і раніше.
    Уподобання — про вибір рейсу, а не про людей: штраф один на пропозицію."""
    people = Decimal(travellers)
    baggage = baggage or {}
    prefs = preferences or FlightPreferences()
    comparable = [o for o in offers if o.currency == config.currency]
    unscored = [offer_key(o) for o in offers if o.currency != config.currency]
    durations = [o.total_duration_min for o in comparable if o.total_duration_min is not None]
    min_duration = min(durations, default=None)

    weights = config.profiles[profile]
    pareto = _pareto_keys(comparable)
    scores = []
    for offer in comparable:
        penalties, warnings = _risks(offer, config)
        if travellers != 1:
            penalties = [
                p.model_copy(update={"amount": _money(p.amount * people)}) for p in penalties
            ]
        risk_total = sum((p.amount for p in penalties), Decimal(0))
        stop_penalty = _money(weights.lambda_stop * offer.stops * people)
        misses = _preference_misses(offer, prefs)
        preference_penalty = sum((getattr(config.preferences, miss) for miss in misses), Decimal(0))
        bag = baggage.get(offer_key(offer))
        baggage_extra = bag.extra if bag is not None else None
        time_penalty: Decimal | None = None
        total: Decimal | None = None
        if offer.total_duration_min is not None and min_duration is not None:
            extra_hours = Decimal(offer.total_duration_min - min_duration) / MINUTES_PER_HOUR
            time_penalty = _money(weights.lambda_time_per_hour * extra_hours * people)
            total = _money(
                offer.price
                + (baggage_extra or 0)
                + time_penalty
                + stop_penalty
                + risk_total
                + preference_penalty
            )
        scores.append(
            OfferScore(
                offer_key=offer_key(offer),
                breakdown=ScoreBreakdown(
                    price=offer.price,
                    baggage_extra=baggage_extra,
                    time_penalty=time_penalty,
                    stop_penalty=stop_penalty,
                    risk_penalties=penalties,
                    risk_total=_money(risk_total),
                    preference_penalty=_money(preference_penalty),
                    preference_misses=misses,
                    total=total,
                ),
                warnings=warnings,
                pareto_optimal=offer_key(offer) in pareto,
            )
        )

    picks = _picks(comparable, {s.offer_key: s for s in scores}, baggage)
    with_baggage = bool(_known_with_baggage(comparable, baggage))
    scores = _with_reasons(comparable, scores, picks, baggage, prefs, with_baggage=with_baggage)
    return ScoringResult(
        profile=profile,
        currency=config.currency,
        min_duration_min=min_duration,
        scores=scores,
        picks=picks,
        unscored_offer_keys=unscored,
        cheapest_basis="with_baggage" if with_baggage else "ticket",
    )


def _preference_misses(offer: Offer, prefs: FlightPreferences) -> list[PreferenceMiss]:
    """Невідомі перевізники чи час — не «невідповідність» (як і у фільтрах, ADR 0004)."""
    misses: list[PreferenceMiss] = []
    if prefs.airlines and offer.airlines and not set(offer.airlines) & set(prefs.airlines):
        misses.append("airline")
    if prefs.departure_periods and not _departs_in(offer, prefs):
        misses.append("departure_time")
    return misses


def _departs_in(offer: Offer, prefs: FlightPreferences) -> bool:
    hour = offer.outbound.departure_at.hour
    return any(_in_hours(hour, *DEPARTURE_PERIOD_HOURS[p]) for p in prefs.departure_periods)


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
        arrival = leg.arrival_at
        if arrival is not None and th.night_start_hour <= arrival.hour < th.night_end_hour:
            penalties.append(
                RiskPenalty(
                    code="night_arrival",
                    leg=name,
                    amount=pen.night_arrival,
                    airport=leg.destination,
                )
            )
        # Зміна аеропорту — лише з посегментних даних (без них — невідомо, без штрафу).
        segments = leg.segments or []
        for prev, nxt in pairwise(segments):
            if prev.destination != nxt.origin:
                penalties.append(
                    RiskPenalty(
                        code="airport_change",
                        leg=name,
                        amount=pen.airport_change,
                        airport=f"{prev.destination}→{nxt.origin}",
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


def _known_with_baggage(offers: Sequence[Offer], baggage: Mapping[str, BaggageCost]) -> list[Offer]:
    """Пропозиції, чия кінцева вартість з потрібним багажем відома."""
    return [
        o for o in offers if (c := baggage.get(offer_key(o))) is not None and c.total is not None
    ]


def _picks(
    offers: Sequence[Offer], scores: dict[str, OfferScore], baggage: Mapping[str, BaggageCost]
) -> list[Pick]:
    if not offers:
        return []
    winners: dict[PickLabel, str] = {}

    # Найдешевший (тривалість для нього не потрібна). Якщо кінцева вартість з багажем відома
    # хоч для когось — лише серед таких і за нею: пропозиція з невідомими обов'язковими
    # платежами не може бути «найдешевшою» поряд з відомими (ADR 0014).
    known = _known_with_baggage(offers, baggage)
    if known:
        cheapest = min(
            known,
            key=lambda o: (baggage[offer_key(o)].total or o.price, o.stops, offer_key(o)),
        )
    else:
        possible = [
            o
            for o in offers
            if getattr(baggage.get(offer_key(o)), "status", None) != "not_available"
        ] or list(offers)
        cheapest = min(possible, key=lambda o: (o.price, o.stops, offer_key(o)))
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


def _with_reasons(
    offers: Sequence[Offer],
    scores: list[OfferScore],
    picks: list[Pick],
    baggage: Mapping[str, BaggageCost],
    prefs: FlightPreferences,
    *,
    with_baggage: bool,
) -> list[OfferScore]:
    """«Чому цей варіант?» для кожної оціненої пропозиції: що вона виграла і чим відрізняється
    від найдешевшого та найшвидшого — у грошах, хвилинах і пересадках з тих самих даних."""
    by_key = {offer_key(o): o for o in offers}
    winners = {label: p.offer_key for p in picks for label in (p.label, *p.also)}
    risks = {s.offer_key: {r.code for r in s.breakdown.risk_penalties} for s in scores}

    def cost(o: Offer) -> Decimal | None:
        """Ціна для порівняння — та сама база, що й у «найдешевшого»."""
        if not with_baggage:
            return o.price
        bag = baggage.get(offer_key(o))
        return bag.total if bag is not None else None

    cheapest = by_key.get(winners.get("cheapest", ""))
    fastest = by_key.get(winners.get("fastest", ""))
    result = []
    for score in scores:
        key = score.offer_key
        offer = by_key[key]
        reasons: list[Reason] = []
        if len(offers) == 1:
            reasons.append(Reason(code="only_option"))
        else:
            if winners.get("cheapest") == key:
                reasons.append(Reason(code="cheapest", count=len(offers)))
            if winners.get("fastest") == key:
                reasons.append(Reason(code="fastest", count=len(offers)))
            if winners.get("balanced") == key:
                reasons.append(Reason(code="best_balance", amount=score.breakdown.total))
        mine = cost(offer)
        if cheapest is not None and cheapest is not offer:
            base = cost(cheapest)
            gain = _minutes(cheapest) - _minutes(offer) if _timed(cheapest, offer) else 0
            if mine is not None and base is not None and gain >= MIN_TIME_GAIN_MIN:
                reasons.append(
                    Reason(
                        code="pricier_but_faster",
                        vs="cheapest",
                        amount=max(mine - base, Decimal(0)),
                        minutes=gain,
                    )
                )
            if offer.stops < cheapest.stops:
                reasons.append(
                    Reason(code="fewer_stops", vs="cheapest", count=cheapest.stops - offer.stops)
                )
            reasons.extend(
                Reason(code="avoids_risk", vs="cheapest", risk=code)
                for code in sorted(risks[offer_key(cheapest)] - risks[key])
            )
        if fastest is not None and fastest is not offer and _timed(fastest, offer):
            base = cost(fastest)
            loss = _minutes(offer) - _minutes(fastest)
            if mine is not None and base is not None and mine < base and loss > 0:
                reasons.append(
                    Reason(
                        code="cheaper_but_slower", vs="fastest", amount=base - mine, minutes=loss
                    )
                )
        bag = baggage.get(key)
        if bag is not None and bag.status == "included":
            reasons.append(Reason(code="baggage_included"))
        if prefs.airlines and set(offer.airlines) & set(prefs.airlines):
            reasons.append(Reason(code="preferred_airline"))
        if prefs.departure_periods and _departs_in(offer, prefs):
            reasons.append(Reason(code="preferred_time"))
        result.append(score.model_copy(update={"reasons": reasons}))
    return result


def _timed(*offers: Offer) -> bool:
    return all(o.total_duration_min is not None for o in offers)


def _minutes(offer: Offer) -> int:
    return offer.total_duration_min or 0
