"""Комбінований підбір «переліт + житло» за загальною вартістю (етап 6, ADR 0009).

1. Перельоти туди-назад — звичайний пошук і скоринг; кандидати — його «Наш вибір» (до 3).
2. Для кожного рейсу житло з дня ПРИЛЬОТУ до дня вильоту НАЗАД (місцеві дати аеропортів);
   різних вікон дат — не більше MAX_STAY_WINDOWS (з реальним джерелом житла кожне — запит).
3. Комбінації «рейс × рекомендоване житло його вікна» з двома сумами:
   - `money_total` — скільки заплатите: переліт × дорослі + житло за всі ночі;
   - `value_total` — вигідність: оцінка перельоту × дорослі + оцінка житла × ночі
     (ціна плюс «ціна» незручностей — часу, пересадок, відстані, умов).
4. Вибір: найдешевша, найвигідніша, найзручніша (найшвидший рейс + найкращий рейтинг житла).
Усі числа рахує код; ШІ лише переказує їх.
"""

import asyncio
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import FlightQuery, Money, Offer
from tickets_api.domain.stays import Stay, StayQuery
from tickets_api.domain.trips import FLIGHT_PROFILE, STAY_PROFILE, TripQuery
from tickets_api.scoring.engine import OfferScore, offer_key
from tickets_api.scoring.stays import StayScore, stay_key
from tickets_api.services.flight_search import AirlineFacet, FlightSearchService, ProviderStatus
from tickets_api.services.stay_search import StaySearchResult, StaySearchService

MAX_STAY_WINDOWS = 3
EARLY_ARRIVAL_HOUR = 6
"""Приліт до 06:00 — заселення зазвичай з 14:00, а ніч перед прильотом у суму не входить."""

TripPickLabel = Literal["cheapest", "best_value", "comfort"]
TripWarning = Literal["early_arrival", "children_not_priced", "value_unknown"]
LABEL_PRECEDENCE: tuple[TripPickLabel, ...] = ("best_value", "cheapest", "comfort")
DISPLAY_ORDER: tuple[TripPickLabel, ...] = ("cheapest", "best_value", "comfort")


class StayWindow(BaseModel):
    check_in: date
    check_out: date
    nights: int


class TripCombo(BaseModel):
    key: str
    offer_key: str
    stay_key: str
    window: StayWindow
    flight_price: Money
    """Ціна перельоту за одного дорослого."""
    flight_total: Money
    """× кількість дорослих."""
    stay_total: Money
    """Житло за всі ночі з податками, за весь номер."""
    money_total: Money
    value_total: Money | None
    """None — оцінку перельоту не порахувати (невідома тривалість)."""
    currency: str
    warnings: list[TripWarning] = []


class TripPick(BaseModel):
    label: TripPickLabel
    combo_key: str
    also: list[TripPickLabel] = []


class TripBudget(BaseModel):
    budget: Money
    within: int
    """Скільки комбінацій вкладаються в бюджет."""
    shortfall: Money | None
    """Якщо жодна не вкладається: на скільки дешевша з них перевищує бюджет."""


class TripSearchResult(BaseModel):
    query: TripQuery
    flight_query: FlightQuery
    stay_queries: list[StayQuery]
    offers: list[Offer]
    """Рейси, що входять у комбінації."""
    stays: list[Stay]
    """Житло, що входить у комбінації."""
    combos: list[TripCombo]
    """Від найвигіднішої до найменш вигідної (у межах бюджету — першими)."""
    picks: list[TripPick]
    budget: TripBudget | None = None
    providers: list[ProviderStatus]
    flights_found: int
    """Скільки рейсів знайшов пошук (кандидати — лише його «Наш вибір»)."""
    airlines: list[AirlineFacet]
    """Назви авіакомпаній (з фасетів пошуку перельотів)."""


class TripPlanner:
    def __init__(self, flights: FlightSearchService, stays: StaySearchService) -> None:
        self._flights = flights
        self._stays = stays

    async def plan(self, query: TripQuery) -> TripSearchResult:
        flight_query = FlightQuery(
            origin=query.origin,
            destination=query.destination,
            departure_date=query.departure_date,
            return_date=query.return_date,
            flex_days=query.flex_days,
            passengers={"adults": query.adults},
            direct_only=query.direct_only,
            currency=query.currency,
            profile=FLIGHT_PROFILE[query.profile],
        )
        flights = await self._flights.search(flight_query)
        offers = {offer_key(o): o for o in flights.offers}
        flight_scores = {s.offer_key: s for s in flights.scoring.scores}
        candidates = [offers[p.offer_key] for p in flights.scoring.picks if p.offer_key in offers]

        windows: dict[tuple[date, date], list[Offer]] = {}
        for offer in candidates:
            window = stay_window(offer)
            if window is not None:
                windows.setdefault(window, []).append(offer)
        chosen = sorted(windows)[:MAX_STAY_WINDOWS]
        stay_queries = [
            StayQuery(
                city=query.destination,
                check_in=check_in,
                check_out=check_out,
                guests={"adults": query.adults, "children": query.children},
                currency=query.currency,
                profile=STAY_PROFILE[query.profile],
            )
            for check_in, check_out in chosen
        ]
        stay_results: Sequence[StaySearchResult] = await asyncio.gather(
            *(self._stays.search(q) for q in stay_queries)
        )

        combos: list[TripCombo] = []
        used_stays: dict[str, Stay] = {}
        for (check_in, check_out), result in zip(chosen, stay_results, strict=True):
            nights = (check_out - check_in).days
            stays = {stay_key(s): s for s in result.stays}
            stay_scores = {s.stay_key: s for s in result.scoring.scores}
            stay_picks = [p.stay_key for p in result.scoring.picks if p.stay_key in stays]
            for offer in windows[(check_in, check_out)]:
                for key in stay_picks:
                    stay = stays[key]
                    if stay.currency != offer.currency:
                        continue  # курсів немає — суму в різних валютах не рахуємо
                    used_stays[key] = stay
                    combos.append(
                        _combo(
                            query,
                            offer,
                            flight_scores.get(offer_key(offer)),
                            stay,
                            stay_scores.get(key),
                            StayWindow(check_in=check_in, check_out=check_out, nights=nights),
                        )
                    )

        budget = _budget(query, combos)
        ordered = sorted(combos, key=lambda c: _rank(c, query.budget_total))
        used_offers = {c.offer_key for c in ordered}
        return TripSearchResult(
            query=query,
            flight_query=flight_query,
            stay_queries=stay_queries,
            offers=[o for k, o in offers.items() if k in used_offers],
            stays=list(used_stays.values()),
            combos=ordered,
            picks=_picks(ordered, offers, used_stays, query.budget_total),
            budget=budget,
            providers=[
                *flights.providers,
                *(p for r in stay_results for p in r.providers),
            ],
            flights_found=len(flights.offers),
            airlines=flights.facets.airlines,
        )


def stay_window(offer: Offer) -> tuple[date, date] | None:
    """Ночі житла: від дати прильоту туди до дати вильоту назад (місцеві дати)."""
    if offer.inbound is None:
        return None
    out = offer.outbound
    check_in = (out.arrival_at or out.departure_at).date()
    check_out = offer.inbound.departure_at.date()
    return (check_in, check_out) if check_out > check_in else None


def _combo(
    query: TripQuery,
    offer: Offer,
    flight_score: OfferScore | None,
    stay: Stay,
    stay_score: StayScore | None,
    window: StayWindow,
) -> TripCombo:
    adults = Decimal(query.adults)
    flight_total = offer.price * adults
    flight_value = flight_score.breakdown.total if flight_score else None
    stay_value = stay_score.breakdown.total if stay_score else None
    value = (
        None
        if flight_value is None or stay_value is None
        else flight_value * adults + stay_value * window.nights
    )
    warnings: list[TripWarning] = []
    arrival = offer.outbound.arrival_at
    if arrival is not None and arrival.hour < EARLY_ARRIVAL_HOUR:
        warnings.append("early_arrival")
    if query.children:
        warnings.append("children_not_priced")
    if value is None:
        warnings.append("value_unknown")
    return TripCombo(
        key=f"{offer_key(offer)}|{stay_key(stay)}",
        offer_key=offer_key(offer),
        stay_key=stay_key(stay),
        window=window,
        flight_price=offer.price,
        flight_total=flight_total,
        stay_total=stay.total_price,
        money_total=flight_total + stay.total_price,
        value_total=value,
        currency=offer.currency,
        warnings=warnings,
    )


def _within(combo: TripCombo, budget: int | None) -> bool:
    return budget is None or combo.money_total <= budget


def _rank(combo: TripCombo, budget: int | None) -> tuple[bool, Decimal, Decimal]:
    """У межах бюджету — першими, далі за вигідністю, потім за ціною."""
    value = combo.value_total if combo.value_total is not None else Decimal("Infinity")
    return (not _within(combo, budget), value, combo.money_total)


def _budget(query: TripQuery, combos: list[TripCombo]) -> TripBudget | None:
    if query.budget_total is None:
        return None
    within = [c for c in combos if _within(c, query.budget_total)]
    cheapest = min((c.money_total for c in combos), default=None)
    return TripBudget(
        budget=Decimal(query.budget_total),
        within=len(within),
        shortfall=None if within or cheapest is None else cheapest - Decimal(query.budget_total),
    )


def _picks(
    combos: list[TripCombo],
    offers: dict[str, Offer],
    stays: dict[str, Stay],
    budget: int | None,
) -> list[TripPick]:
    # Вибір — серед тих, що в бюджеті; якщо таких немає — серед усіх (і бюджет це покаже).
    pool = [c for c in combos if _within(c, budget)] or combos
    if not pool:
        return []

    def duration(c: TripCombo) -> int:
        minutes = offers[c.offer_key].total_duration_min
        return minutes if minutes is not None else 10**9

    def rating(c: TripCombo) -> Decimal:
        r = stays[c.stay_key].rating
        return r if r is not None else Decimal(-1)

    winners: dict[TripPickLabel, str] = {
        "cheapest": min(pool, key=lambda c: (c.money_total, _rank(c, budget))).key,
        "best_value": min(pool, key=lambda c: _rank(c, budget)).key,
        "comfort": min(pool, key=lambda c: (duration(c), -rating(c), c.money_total)).key,
    }
    picks: dict[str, TripPick] = {}
    for label in LABEL_PRECEDENCE:
        key = winners[label]
        if key in picks:
            picks[key].also.append(label)
        else:
            picks[key] = TripPick(label=label, combo_key=key)
    order = {label: i for i, label in enumerate(DISPLAY_ORDER)}
    return sorted(picks.values(), key=lambda p: order[p.label])
