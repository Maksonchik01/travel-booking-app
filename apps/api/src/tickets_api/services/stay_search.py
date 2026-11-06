"""Агрегація джерел житла з graceful degradation + value-score.

Як і для перельотів: кожне джерело опитується паралельно з власним таймаутом, збій одного
не ламає відповідь. Фільтри видачі — після провайдерів; історія пише все отримане.
"""

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import structlog
from pydantic import BaseModel

from tickets_api.domain.flights import Money
from tickets_api.domain.stays import Stay, StayKind, StayPlace, StayQuery, StayReview
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


class StayFacets(BaseModel):
    """Що є у видачі ДО фільтрів — для варіантів фільтрів у UI."""

    total_stays: int
    kinds: list[KindFacet]
    min_price_per_night: Money | None
    max_price_per_night: Money | None


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
        return StayPlace(code=city.code, name=city.name_uk or city.name, country=city.country)

    async def search(self, query: StayQuery) -> StaySearchResult:
        results = await asyncio.gather(*(self._call(p, query) for p in self._providers))
        stays = sorted(
            (stay for _, items in results for stay in items),
            key=lambda s: (s.price_per_night, s.source, s.id),
        )
        if self._record_history:
            await self._record_history(stay_rows(query, stays))
        shown = [s for s in stays if query.filters.matches(s)]
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
    return StayFacets(
        total_stays=len(stays),
        kinds=[KindFacet(kind=k, stays=n) for k, n in counts.most_common()],
        min_price_per_night=min(prices) if prices else None,
        max_price_per_night=max(prices) if prices else None,
    )
