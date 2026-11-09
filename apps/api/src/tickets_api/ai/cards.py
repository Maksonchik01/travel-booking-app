"""Картки результатів у чаті (модуль 9b). Будує код з тих самих результатів пошуку, що й
відповідь моделі: ціни, час і наявність — лише від джерел, модель їх не формує.

Кожна картка несе статус ціни (жива / кешована з часом знаходження) — UI позначає
застарілі дані. Картка поїздки містить запит з вибором рейсу й житла: «Відкрити в
планувальнику» відкриває саме цю комбінацію без втрат параметрів.
"""

from collections.abc import Mapping
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from tickets_api.ai.explainer import TITLES
from tickets_api.ai.stay_payload import STAY_TITLES
from tickets_api.domain.flights import FlightQuery, Leg, Money, Offer
from tickets_api.domain.stays import Stay, StayKind
from tickets_api.domain.trips import TripQuery
from tickets_api.scoring.engine import offer_key
from tickets_api.scoring.stays import stay_key
from tickets_api.services.flight_search import FlightSearchResult
from tickets_api.services.stay_search import StaySearchResult
from tickets_api.services.trip_planner import TripCombo, TripSearchResult

MAX_CARDS = 3


class LegCard(BaseModel):
    origin: str
    destination: str
    departure_at: datetime
    """Місцевий час аеропорту, як у пропозиції."""
    arrival_at: datetime | None
    stops: int


class FlightCard(BaseModel):
    kind: Literal["flight"] = "flight"
    key: str
    label: str | None = None
    airlines: list[str]
    """Назви (з довідника), а без назви — коди."""
    outbound: LegCard
    inbound: LegCard | None
    duration_min: int | None
    stops: int
    price: Money
    """За всіх пасажирів пошуку."""
    currency: str
    price_status: Literal["live", "cached"]
    found_at: datetime | None


class StayCard(BaseModel):
    kind: Literal["stay"] = "stay"
    key: str
    label: str | None = None
    name: str
    stay_kind: StayKind
    image_url: str | None
    rating: float | None
    review_count: int
    district: str | None
    distance_to_center_km: float | None
    price_per_night: Money
    total_price: Money
    nights: int
    currency: str
    found_at: datetime | None


class TripCard(BaseModel):
    kind: Literal["trip"] = "trip"
    key: str
    label: str | None = None
    money_total: Money
    """Відомі складові (підтверджені + орієнтовні)."""
    unknown_parts: int
    currency: str
    check_in: date
    check_out: date
    nights: int
    prices_cached: bool
    flight: FlightCard
    stay: StayCard
    query: TripQuery
    """Запит з обраним рейсом і житлом — «Відкрити в планувальнику»."""


ChatCard = Annotated[FlightCard | StayCard | TripCard, Field(discriminator="kind")]


def _leg(leg: Leg) -> LegCard:
    return LegCard(
        origin=leg.origin,
        destination=leg.destination,
        departure_at=leg.departure_at,
        arrival_at=leg.arrival_at,
        stops=leg.stops,
    )


def flight_card(offer: Offer, names: Mapping[str, str], label: str | None = None) -> FlightCard:
    return FlightCard(
        key=offer_key(offer),
        label=label,
        airlines=[names.get(code, code) for code in offer.airlines],
        outbound=_leg(offer.outbound),
        inbound=_leg(offer.inbound) if offer.inbound else None,
        duration_min=offer.total_duration_min,
        stops=offer.stops,
        price=offer.price,
        currency=offer.currency,
        price_status=offer.price_status,
        found_at=offer.found_at or offer.collected_at,
    )


def stay_card(stay: Stay, label: str | None = None) -> StayCard:
    return StayCard(
        key=stay_key(stay),
        label=label,
        name=stay.name,
        stay_kind=stay.kind,
        image_url=stay.image_url if (stay.image_url or "").startswith("https://") else None,
        rating=float(stay.rating) if stay.rating is not None else None,
        review_count=stay.review_count,
        district=stay.district,
        distance_to_center_km=float(stay.distance_to_center_km)
        if stay.distance_to_center_km is not None
        else None,
        price_per_night=stay.price_per_night,
        total_price=stay.total_price,
        nights=stay.nights,
        currency=stay.currency,
        found_at=stay.found_at or stay.collected_at,
    )


def flight_cards(
    query: FlightQuery, result: FlightSearchResult, names: Mapping[str, str]
) -> list[FlightCard]:
    """«Наш вибір» пошуку (до трьох) — ті самі варіанти, що бачить модель."""
    offers = {offer_key(o): o for o in result.offers}
    return [
        flight_card(offers[p.offer_key], names, TITLES[p.label])
        for p in result.scoring.picks[:MAX_CARDS]
        if p.offer_key in offers
    ]


def stay_cards(result: StaySearchResult) -> list[StayCard]:
    stays = {stay_key(s): s for s in result.stays}
    return [
        stay_card(stays[p.stay_key], STAY_TITLES[p.label])
        for p in result.scoring.picks[:MAX_CARDS]
        if p.stay_key in stays
    ]


def trip_card(
    query: TripQuery,
    result: TripSearchResult,
    combo: TripCombo,
    names: Mapping[str, str],
    label: str | None = None,
) -> TripCard:
    offer = next(o for o in result.offers if offer_key(o) == combo.offer_key)
    stay = result.stays[combo.stay_index]
    return TripCard(
        key=combo.key,
        label=label,
        money_total=combo.money_total,
        unknown_parts=combo.costs.unknown,
        currency=combo.currency,
        check_in=combo.window.check_in,
        check_out=combo.window.check_out,
        nights=combo.window.nights,
        prices_cached=offer.price_status != "live",
        flight=flight_card(offer, names),
        stay=stay_card(stay),
        query=query.model_copy(update={"flight": combo.offer_key, "stay": combo.stay_key}),
    )


def trip_cards(
    query: TripQuery, result: TripSearchResult, names: Mapping[str, str], titles: dict[str, str]
) -> list[TripCard]:
    """Сценарії поїздки (Економ / Оптимальний / Комфорт) — кожен відкривається в планувальнику."""
    combos = {c.key: c for c in result.combos}
    return [
        trip_card(query, result, combos[p.combo_key], names, titles[p.label])
        for p in result.picks[:MAX_CARDS]
        if p.combo_key in combos
    ]
