"""Explore — напрямки за бюджетом (ADR 0045).

Перельоти — з кешованих джерел (`FlightSearchService.explore_offers`): кілька запитів на весь
пошук, без квоти. Найдешевший квиток на кожне місто, що підходить під дати, ночі, напрямок,
категорії й бюджет. Режим «авіаквитки + житло» — житло лише для `STAY_LOOKUPS` найдешевших
напрямків (платне джерело, ADR 0044); решта — `not_checked`, а не вигадана сума.
"""

import asyncio
from decimal import Decimal
from math import ceil

import structlog
from pydantic import BaseModel

from tickets_api.domain.explore import (
    ExploreDestination,
    ExploreQuery,
    ExploreStay,
    StayStatus,
)
from tickets_api.domain.flights import Leg, Offer, stay_nights
from tickets_api.domain.freshness import PriceFreshness
from tickets_api.domain.stays import MAX_NIGHTS, Guests, Stay, StayFilters, StayQuery
from tickets_api.providers.budget import optional_spend
from tickets_api.reference.airports import AirportDirectory
from tickets_api.reference.destinations import DestinationDirectory
from tickets_api.scoring.engine import offer_key
from tickets_api.scoring.stays import stay_key
from tickets_api.services.flight_search import FlightSearchService, ProviderStatus
from tickets_api.services.stay_search import StaySearchResult, StaySearchService

log = structlog.get_logger(__name__)

STAY_LOOKUPS = 3
"""Скільки найдешевших напрямків перевіряємо на житло (власник обрав топ-3: 10 кредитів кожен)."""
ADULTS_PER_ROOM = 2


class ExploreResult(BaseModel):
    destinations: list[ExploreDestination]
    found: int
    """Скільки напрямків підійшло до обрізання за `limit`."""
    providers: list[ProviderStatus]
    stays_checked: int = 0
    """Скільки напрямків перевірено на житло (кожен — платний запит, якщо не з кешу)."""


class ExploreService:
    def __init__(
        self,
        flights: FlightSearchService,
        stays: StaySearchService | None,
        *,
        airports: AirportDirectory,
        destinations: DestinationDirectory,
        stay_lookups: int = STAY_LOOKUPS,
    ) -> None:
        self._flights = flights
        self._stays = stays
        self._airports = airports
        self._destinations = destinations
        self._stay_lookups = stay_lookups

    async def explore(self, query: ExploreQuery) -> ExploreResult:
        statuses, tagged = await self._flights.explore_offers(query)
        home = {self._city(code) for code in query.origins}
        best: dict[str, Offer] = {}
        for _, raw in tagged:
            if not query.fits(raw):
                continue
            city = self._city(raw.inbound.origin if raw.inbound else raw.outbound.destination)
            if city is None or city in home or not self._in_scope(city, raw, query):
                continue
            offer = raw.model_copy(update={"price": raw.price * query.adults})
            if query.budget is not None and offer.price > query.budget:
                continue
            current = best.get(city)
            if current is None or (offer.price, offer.id) < (current.price, current.id):
                best[city] = offer
        ranked = sorted(best.items(), key=lambda item: (item[1].price, item[0]))
        freshness = self._flights.freshness([o for _, o in ranked])
        destinations = [
            self._destination(city, offer, inbound, query, freshness[offer_key(offer)])
            for city, offer in ranked
            if (inbound := offer.inbound) is not None  # query.fits пропускає лише туди-назад
        ]
        checked = 0
        if query.mode == "trip":
            destinations, checked = await self._with_stays(destinations, query)
        return ExploreResult(
            destinations=destinations[: query.limit],
            found=len(destinations),
            providers=statuses,
            stays_checked=checked,
        )

    # --- внутрішнє -----------------------------------------------------------------

    def _city(self, code: str) -> str | None:
        city = self._airports.city_of(code)
        return city.code if city is not None else None

    def _in_scope(self, city: str, offer: Offer, query: ExploreQuery) -> bool:
        info = self._airports.city_of(city)
        country = info.country if info is not None else None
        if query.country is not None and country != query.country:
            return False
        if query.region is not None and (
            country is None or self._destinations.region_of(country) != query.region
        ):
            return False
        if query.categories:
            known = self._destinations.info(city)
            departure = offer.outbound.departure_at.date()
            if known is None or not known.matches(query.categories, departure):
                return False
        return True

    def _destination(
        self, city: str, offer: Offer, inbound: Leg, query: ExploreQuery, freshness: PriceFreshness
    ) -> ExploreDestination:
        place = self._airports.city_of(city)
        info = self._destinations.info(city)
        nights, approximate = stay_nights(offer.outbound, inbound)
        name = city
        if place is not None:
            name = place.name_uk if query.lang == "uk" and place.name_uk else place.name
        return ExploreDestination(
            code=city,
            city_name=name,
            country=place.country if place is not None else "",
            lat=place.lat if place is not None else None,
            lon=place.lon if place is not None else None,
            categories=list(info.categories) if info is not None else [],
            photo=info.photo if info is not None else None,
            offer=offer,
            nights=nights,
            nights_approximate=approximate,
            freshness=freshness,
            stay_status="not_checked" if query.mode == "trip" else None,
        )

    async def _with_stays(
        self, destinations: list[ExploreDestination], query: ExploreQuery
    ) -> tuple[list[ExploreDestination], int]:
        stays = self._stays
        if stays is None:
            return [d.model_copy(update={"stay_status": "unsupported"}) for d in destinations], 0
        head = destinations[: self._stay_lookups]
        # Житло в Explore — необов'язкова витрата scrape.do: зупиняється раніше за пошук (ADR 0055).
        with optional_spend():
            checked = await asyncio.gather(*(self._stay_for(stays, d, query) for d in head))
        priced = [d for d in checked if d.total is not None]
        others = [d for d in checked if d.total is None] + destinations[len(head) :]
        # Знайдена загальна сума — нагорі (за сумою), далі решта за ціною перельоту.
        priced.sort(key=lambda d: (d.total or Decimal(0), d.code))
        return priced + others, len(head)

    async def _stay_for(
        self, stays: StaySearchService, destination: ExploreDestination, query: ExploreQuery
    ) -> ExploreDestination:
        offer = destination.offer
        arrival = offer.outbound.arrival_at
        check_in = (arrival or offer.outbound.departure_at).date()
        check_out = offer.inbound.departure_at.date() if offer.inbound else check_in
        if not 0 < (check_out - check_in).days <= MAX_NIGHTS:
            return destination.model_copy(update={"stay_status": "none"})
        left = None
        if query.budget is not None:
            left = int(Decimal(query.budget) - offer.price)
            if left < 1:
                return destination.model_copy(update={"stay_status": "none"})
        stay_query = StayQuery(
            city=destination.code,
            check_in=check_in,
            check_out=check_out,
            guests=Guests(adults=query.adults, rooms=ceil(query.adults / ADULTS_PER_ROOM)),
            currency=query.currency,
            filters=StayFilters(max_total_price=left),
        )
        try:
            result = await stays.search(stay_query)
        except Exception:
            log.exception("explore.stay_failed")
            return destination.model_copy(update={"stay_status": "error"})
        stay = _pick(result)
        if stay is None:
            return destination.model_copy(update={"stay_status": _empty_status(result)})
        amount = stay.total_price
        if stay.currency != query.currency:
            converted = result.converted.get(stay_key(stay))
            if converted is None:
                return destination.model_copy(update={"stay_status": "none"})
            amount = converted.amount
        return destination.model_copy(
            update={
                "stay_status": "ok",
                "stay": ExploreStay(
                    id=stay.id,
                    source=stay.source,
                    name=stay.name,
                    rating=float(stay.rating) if stay.rating is not None else None,
                    total_price=amount,
                    currency=query.currency,
                    taxes_included=stay.taxes_included,
                    image_url=stay.image_url,
                ),
                "total": offer.price + amount,
            }
        )


def _pick(result: StaySearchResult) -> Stay | None:
    """Вибір скорингу житла («збалансований», інакше перший вибір), без нього — найдешевше."""
    by_key = {stay_key(s): s for s in result.stays}
    picks = result.scoring.picks
    for pick in sorted(picks, key=lambda p: p.label != "balanced"):
        if pick.stay_key in by_key:
            return by_key[pick.stay_key]
    return min(result.stays, key=lambda s: s.total_price, default=None)


def _empty_status(result: StaySearchResult) -> StayStatus:
    statuses = {p.status for p in result.providers}
    if "ok" in statuses or not statuses:
        return "none"
    for status in ("unsupported", "rate_limited"):
        if status in statuses:
            return status
    return "error"
