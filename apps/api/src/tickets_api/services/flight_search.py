"""Агрегація провайдерів перельотів з graceful degradation.

Кожен провайдер опитується паралельно з власним таймаутом. Помилка чи таймаут одного
не ламають відповідь: повертаємо те, що отримали, і статус кожного джерела.
"""

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import date
from typing import Any, Literal

import structlog
from pydantic import BaseModel

from tickets_api.domain.flights import CalendarDay, FlightQuery, Offer
from tickets_api.providers.base import FlightProvider, ProviderError, ProviderRateLimitedError
from tickets_api.repositories.price_history import calendar_rows, offer_rows
from tickets_api.scoring.config import ScoringConfig
from tickets_api.scoring.engine import ScoringResult, score_offers

log = structlog.get_logger(__name__)

RecordHistory = Callable[[list[dict[str, Any]]], Awaitable[None]]


class ProviderStatus(BaseModel):
    provider: str
    status: Literal["ok", "error", "timeout", "rate_limited"]
    """rate_limited — вичерпано квоту/ліміт запитів джерела (UI пояснює це окремо)."""
    error: str | None = None
    results: int = 0


class AirlineFacet(BaseModel):
    code: str
    name: str | None
    """None — авіакомпанії немає в довіднику; UI показує код."""
    offers: int


class SearchFacets(BaseModel):
    """Що є у видачі ДО фільтрів — щоб UI показав доступні варіанти фільтрів."""

    total_offers: int
    airlines: list[AirlineFacet]


class FlightSearchResult(BaseModel):
    offers: list[Offer]
    """Лише ті, що пройшли `query.filters`; скоринг рахується по них же."""
    providers: list[ProviderStatus]
    scoring: ScoringResult
    facets: SearchFacets


class CalendarResult(BaseModel):
    days: list[CalendarDay]
    providers: list[ProviderStatus]


class FlightSearchService:
    def __init__(
        self,
        providers: Sequence[FlightProvider],
        *,
        calendar_providers: Sequence[FlightProvider] | None = None,
        timeout_s: float,
        scoring_config: ScoringConfig,
        record_history: RecordHistory | None = None,
        airline_names: Mapping[str, str] | None = None,
    ) -> None:
        self._providers = list(providers)
        # Календар може йти з інших джерел (напр. живий пошук без календаря + кешований календар).
        self._calendar_providers = (
            list(calendar_providers) if calendar_providers is not None else self._providers
        )
        self._timeout_s = timeout_s
        self._scoring_config = scoring_config
        self._record_history = record_history
        self._airline_names = airline_names or {}

    @property
    def airline_names(self) -> Mapping[str, str]:
        return self._airline_names

    async def search(self, query: FlightQuery) -> FlightSearchResult:
        results = await self._gather(self._providers, lambda p: p.search(query))
        offers = sorted(
            (offer for _, items in results for offer in items),
            key=lambda o: (o.price, o.source, o.id),
        )
        if self._record_history:
            # В історію — усе отримане, фільтри видачі її не стосуються.
            await self._record_history(offer_rows(query.origin, query.destination, offers))
        shown = [o for o in offers if query.filters.matches(o)]
        return FlightSearchResult(
            offers=shown,
            providers=[s for s, _ in results],
            # «Найшвидший» і мінімальний час — серед того, що користувач бачить.
            scoring=score_offers(shown, query.profile, self._scoring_config),
            facets=self._facets(offers),
        )

    def _facets(self, offers: list[Offer]) -> SearchFacets:
        counts = Counter(code for o in offers for code in set(o.airlines))
        return SearchFacets(
            total_offers=len(offers),
            airlines=[
                AirlineFacet(code=code, name=self._airline_names.get(code), offers=n)
                for code, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        )

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> CalendarResult:
        results = await self._gather(
            self._calendar_providers, lambda p: p.calendar(origin, destination, month, currency)
        )
        all_days = [day for _, items in results for day in items]
        if self._record_history:
            await self._record_history(calendar_rows(origin, destination, all_days))
        return CalendarResult(
            days=_cheapest_per_day(all_days, currency.upper()),
            providers=[s for s, _ in results],
        )

    async def _gather[T](
        self,
        providers: Sequence[FlightProvider],
        call: Callable[[FlightProvider], Awaitable[list[T]]],
    ) -> list[tuple[ProviderStatus, list[T]]]:
        return list(await asyncio.gather(*(self._call(p, call) for p in providers)))

    async def _call[T](
        self, provider: FlightProvider, call: Callable[[FlightProvider], Awaitable[list[T]]]
    ) -> tuple[ProviderStatus, list[T]]:
        name = provider.name
        timeout_s = getattr(provider, "timeout_s", None) or self._timeout_s
        try:
            items = await asyncio.wait_for(call(provider), timeout=timeout_s)
        except TimeoutError:
            log.warning("provider.timeout", provider=name, timeout_s=timeout_s)
            return ProviderStatus(provider=name, status="timeout", error="timeout"), []
        except ProviderRateLimitedError as exc:
            log.warning("provider.rate_limited", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="rate_limited", error=exc.message), []
        except ProviderError as exc:
            log.warning("provider.error", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="error", error=exc.message), []
        except Exception:
            # Неочікуване — у лог і Sentry з трасою, назовні — без деталей.
            log.exception("provider.unexpected_error", provider=name)
            return ProviderStatus(provider=name, status="error", error="internal error"), []
        return ProviderStatus(provider=name, status="ok", results=len(items)), items


def _cheapest_per_day(days: list[CalendarDay], currency: str) -> list[CalendarDay]:
    """Кілька провайдерів → одна (найнижча) ціна на день. Ціни в іншій валюті не порівнюємо."""
    best: dict[date, CalendarDay] = {}
    for day in days:
        if day.currency != currency:
            continue
        current = best.get(day.date)
        if current is None or day.price < current.price:
            best[day.date] = day
    return [best[d] for d in sorted(best)]
