"""Агрегація джерел житла з graceful degradation + value-score.

Як і для перельотів: кожне джерело опитується паралельно з власним таймаутом, збій одного
не ламає відповідь. Фільтри видачі — після провайдерів; історія пише все отримане.
"""

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Literal

import structlog
from pydantic import BaseModel

from tickets_api.domain.flights import Money
from tickets_api.domain.stays import (
    GeoPoint,
    Stay,
    StayFilters,
    StayKind,
    StayPlace,
    StayQuery,
    StayReview,
)
from tickets_api.providers.base import ProviderError, ProviderRateLimitedError, StayProvider
from tickets_api.reference.airports import AirportDirectory
from tickets_api.repositories.stay_price_history import stay_rows
from tickets_api.scoring.stays import StayScoringConfig, StayScoringResult, score_stays
from tickets_api.services.flight_search import ProviderStatus

log = structlog.get_logger(__name__)

RecordHistory = Callable[[list[dict[str, Any]]], Awaitable[None]]
MAX_REVIEWS = 30


class KindFacet(BaseModel):
    kind: StayKind
    stays: int


class CountFacet(BaseModel):
    value: str
    stays: int


StayData = Literal[
    "rating",
    "cancellation",
    "breakfast",
    "prepayment",
    "pay_at_property",
    "beds",
    "distance",
    "coordinates",
    "district",
]


class StayFacets(BaseModel):
    """Що є у видачі ДО фільтрів — UI показує лише фільтри, для яких є дані (модуль 5)."""

    total_stays: int
    kinds: list[KindFacet]
    min_price_per_night: Money | None
    max_price_per_night: Money | None
    min_total_price: Money | None = None
    max_total_price: Money | None = None
    amenities: list[CountFacet] = []
    """Зручності, що трапляються у видачі, з кількістю об'єктів."""
    districts: list[CountFacet] = []
    available: list[StayData] = []
    """Поля, відомі хоча б для одного об'єкта; немає — фільтр за ним не показуємо."""


class StaySearchResult(BaseModel):
    place: StayPlace | None
    """Місто пошуку; None — код невідомий довіднику."""
    stays: list[Stay]
    """Лише ті, що пройшли `query.filters`; скоринг — по них же."""
    providers: list[ProviderStatus]
    scoring: StayScoringResult
    facets: StayFacets


class StaySearchService:
    def __init__(
        self,
        providers: Sequence[StayProvider],
        *,
        airports: AirportDirectory,
        timeout_s: float,
        scoring_config: StayScoringConfig,
        record_history: RecordHistory | None = None,
    ) -> None:
        self._providers = list(providers)
        self._airports = airports
        self._timeout_s = timeout_s
        self._scoring_config = scoring_config
        self._record_history = record_history

    @property
    def scoring_config(self) -> StayScoringConfig:
        return self._scoring_config

    def place(self, code: str) -> StayPlace | None:
        city = self._airports.city_of(code)
        if city is None:
            return None
        return StayPlace(
            code=city.code,
            name=city.name_uk or city.name,
            country=city.country,
            airports=self._airports.airports_for(city.code),
        )

    def _resolve_point(self, filters: StayFilters) -> StayFilters:
        """«Біля аеропорту» → координати з довідника (невідомий код — фільтр не діє)."""
        if filters.near_airport is None or filters.near is not None:
            return filters
        point = self._airports.coordinates(filters.near_airport)
        if point is None:
            return filters
        return filters.model_copy(update={"near": GeoPoint(lat=point[0], lon=point[1])})

    async def search(self, query: StayQuery) -> StaySearchResult:
        results = await asyncio.gather(*(self._call(p, query) for p in self._providers))
        stays = sorted(
            (stay for _, items in results for stay in items),
            key=lambda s: (s.price_per_night, s.source, s.id),
        )
        if self._record_history:
            await self._record_history(stay_rows(query, stays))
        filters = self._resolve_point(query.filters)
        shown = [s for s in stays if filters.matches(s)]
        return StaySearchResult(
            place=self.place(query.city),
            stays=shown,
            providers=[status for status, _ in results],
            scoring=score_stays(shown, query.profile, self._scoring_config),
            facets=_facets(stays),
        )

    async def reviews(self, source: str, stay_id: str) -> list[StayReview]:
        """Відгуки з того джерела, що дало об'єкт. Збій — порожньо (резюме просто не буде)."""
        provider = next((p for p in self._providers if p.name == source), None)
        if provider is None:
            return []
        try:
            return (
                await asyncio.wait_for(
                    provider.reviews(stay_id, limit=MAX_REVIEWS), timeout=self._timeout_s
                )
            )[:MAX_REVIEWS]
        except (TimeoutError, ProviderError) as exc:
            log.warning("stay_reviews.failed", provider=source, error=type(exc).__name__)
            return []

    async def _call(
        self, provider: StayProvider, query: StayQuery
    ) -> tuple[ProviderStatus, list[Stay]]:
        name = provider.name
        timeout_s = getattr(provider, "timeout_s", None) or self._timeout_s
        try:
            items = await asyncio.wait_for(provider.search(query), timeout=timeout_s)
        except TimeoutError:
            log.warning("stay_provider.timeout", provider=name, timeout_s=timeout_s)
            return ProviderStatus(provider=name, status="timeout", error="timeout"), []
        except ProviderRateLimitedError as exc:
            log.warning("stay_provider.rate_limited", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="rate_limited", error=exc.message), []
        except ProviderError as exc:
            log.warning("stay_provider.error", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="error", error=exc.message), []
        except Exception:
            log.exception("stay_provider.unexpected_error", provider=name)
            return ProviderStatus(provider=name, status="error", error="internal error"), []
        return ProviderStatus(provider=name, status="ok", results=len(items)), items


def _facets(stays: list[Stay]) -> StayFacets:
    counts = Counter(s.kind for s in stays)
    prices = [s.price_per_night for s in stays]
    totals = [s.total_price for s in stays]
    amenities = Counter(a for s in stays for a in s.amenities)
    districts = Counter(s.district for s in stays if s.district)
    known: dict[StayData, bool] = {
        "rating": any(s.rating is not None for s in stays),
        "cancellation": any(s.cancellation is not None for s in stays),
        "breakfast": any(s.breakfast_included is not None for s in stays),
        "prepayment": any(s.prepayment is not None for s in stays),
        "pay_at_property": any(s.pay_at_property is not None for s in stays),
        "beds": any(s.beds is not None for s in stays),
        "distance": any(s.distance_to_center_km is not None for s in stays),
        "coordinates": any(s.latitude is not None and s.longitude is not None for s in stays),
        "district": bool(districts),
    }
    return StayFacets(
        total_stays=len(stays),
        kinds=[KindFacet(kind=k, stays=n) for k, n in counts.most_common()],
        min_price_per_night=min(prices) if prices else None,
        max_price_per_night=max(prices) if prices else None,
        min_total_price=min(totals) if totals else None,
        max_total_price=max(totals) if totals else None,
        amenities=[CountFacet(value=a, stays=n) for a, n in sorted(amenities.items())],
        districts=[CountFacet(value=d, stays=n) for d, n in districts.most_common()],
        available=[name for name, ok in known.items() if ok],
    )
