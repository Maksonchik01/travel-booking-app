"""Агрегація джерел житла з graceful degradation + value-score.

Як і для перельотів: кожне джерело опитується паралельно з власним таймаутом, збій одного
не ламає відповідь. Фільтри видачі — після провайдерів; історія пише все отримане.
"""

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal, cast

import structlog
from pydantic import BaseModel

from tickets_api.domain.flights import Money, _StrictInput
from tickets_api.domain.freshness import FreshnessRules, PriceFreshness, price_freshness
from tickets_api.domain.money import ConvertedPrice, convert, converted
from tickets_api.domain.sanity import drop_implausible, stay_problems
from tickets_api.domain.stay_rates import (
    RateOffer,
    RoomOffers,
    StayRate,
    StayRatesRequest,
    StayRatesResult,
)
from tickets_api.domain.stays import (
    GeoPoint,
    Stay,
    StayFilters,
    StayKind,
    StayPlace,
    StayQuery,
    StayReview,
)
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
    StayProvider,
    StayRateSource,
)
from tickets_api.reference.airports import AirportDirectory
from tickets_api.repositories.stay_price_history import rate_rows, stay_rows
from tickets_api.scoring.stays import StayScoringConfig, StayScoringResult, score_stays, stay_key
from tickets_api.services.flight_search import ProviderStatus

log = structlog.get_logger(__name__)

RecordHistory = Callable[[list[dict[str, Any]]], Awaitable[None]]
RateLookup = Callable[[str, str], Awaitable[Decimal | None]]
"""(база, валюта) → одиниць валюти за одиницю бази; None — курсу немає."""
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
    freshness: dict[str, PriceFreshness] = {}
    """stay_key → свіжість ціни (модуль 17.3). Джерела житла дають ціну на зараз (живі)."""
    converted: dict[str, ConvertedPrice] = {}
    """stay_key → сума за все проживання у валюті пошуку, якщо джерело дало іншу (18.2)."""


class StayDetailRequest(_StrictInput):
    """Сторінка об'єкта (ADR 0044): той самий запит, що дав об'єкт (знайдемо в кеші пошуку)."""

    query: StayQuery
    source: str
    stay_id: str


class StayDetailResult(BaseModel):
    status: Literal["ok", "not_found", "unsupported", "rate_limited", "error"]
    """not_found — об'єкта вже немає у видачі на ці дати (інша ціна, немає місць)."""
    stay: Stay | None = None
    place: StayPlace | None = None
    freshness: PriceFreshness | None = None


class StaySearchService:
    def __init__(
        self,
        providers: Sequence[StayProvider],
        *,
        airports: AirportDirectory,
        timeout_s: float,
        scoring_config: StayScoringConfig,
        record_history: RecordHistory | None = None,
        freshness: FreshnessRules | None = None,
        clock: Callable[[], datetime] | None = None,
        rate: RateLookup | None = None,
    ) -> None:
        self._providers = list(providers)
        self._rate = rate
        self._freshness = freshness or FreshnessRules()
        self._clock = clock or (lambda: datetime.now(UTC))
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
            drop_implausible(
                (stay for _, items in results for stay in items),
                lambda s: stay_problems(s, query),
                "stays",
            ),
            key=lambda s: (s.price_per_night, s.source, s.id),
        )
        if self._record_history:
            await self._record_history(stay_rows(query, stays))
        filters = self._resolve_point(query.filters)
        shown = [s for s in stays if filters.matches(s)]
        # Одна валюта порівняння — валюта пошуку (модуль 18.2); вихідні ціни — у видачі.
        comparable, conversions = await self._in_currency(shown, query.currency)
        config = await self._config_for(query.currency)
        return StaySearchResult(
            place=self.place(query.city),
            stays=shown,
            providers=[status for status, _ in results],
            # Обов'язкові вимоги (фільтри) вже відсікли зайве — оцінка лише ранжує решту.
            scoring=score_stays(
                comparable,
                query.profile,
                config,
                preferences=query.preferences,
                budget=filters.budget_for(query.nights),
            ),
            facets=_facets(stays),
            converted=conversions,
            freshness={
                stay_key(s): price_freshness(
                    live=True,
                    collected_at=s.collected_at,
                    found_at=s.found_at,
                    found_on=None,
                    now=self._clock(),
                    rules=self._freshness,
                )
                for s in shown
            },
        )

    async def _rate_to(self, base: str, currency: str) -> Decimal | None:
        if base == currency:
            return Decimal(1)
        return await self._rate(base, currency) if self._rate is not None else None

    async def _config_for(self, currency: str) -> StayScoringConfig:
        """Ваги value-score у валюті пошуку; без курсу — базові (інша валюта не оцінюється)."""
        base = self._scoring_config
        rate = await self._rate_to(base.currency, currency)
        return base.in_currency(currency, rate) if rate else base

    async def _in_currency(
        self, stays: Sequence[Stay], currency: str
    ) -> tuple[list[Stay], dict[str, ConvertedPrice]]:
        rates = {c: await self._rate_to(c, currency) for c in {s.currency for s in stays}}
        result: list[Stay] = []
        conversions: dict[str, ConvertedPrice] = {}
        for stay in stays:
            rate = rates.get(stay.currency)
            if stay.currency == currency or rate is None:
                result.append(stay)
                continue
            conversions[stay_key(stay)] = converted(stay.total_price, stay.currency, currency, rate)
            result.append(
                stay.model_copy(
                    update={
                        "price_per_night": convert(stay.price_per_night, rate),
                        "total_price": convert(stay.total_price, rate),
                        "currency": currency,
                    }
                )
            )
        return result, conversions

    async def detail(self, request: StayDetailRequest) -> StayDetailResult:
        """Один об'єкт з видачі тих самих дат і гостей. Платне джерело відповідає з кешу пошуку,
        тож відкриття сторінки об'єкта нового запиту не робить (поки кеш живий)."""
        provider = next((p for p in self._providers if p.name == request.source), None)
        if provider is None:
            return StayDetailResult(status="unsupported")
        status, stays = await self._call(provider, request.query)
        if status.status == "unsupported":
            return StayDetailResult(status="unsupported")
        if status.status == "rate_limited":
            return StayDetailResult(status="rate_limited")
        if status.status != "ok":
            return StayDetailResult(status="error")
        stay = next((s for s in stays if s.id == request.stay_id), None)
        if stay is None:
            return StayDetailResult(status="not_found", place=self.place(request.query.city))
        return StayDetailResult(
            status="ok",
            stay=stay,
            place=self.place(request.query.city),
            freshness=price_freshness(
                live=True,
                collected_at=stay.collected_at,
                found_at=stay.found_at,
                found_on=None,
                now=self._clock(),
                rules=self._freshness,
            ),
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

    async def rates(self, request: StayRatesRequest) -> StayRatesResult:
        """Тарифи продавців на об'єкт (модуль 7), згруповані за однаковими умовами.

        Джерело без такої здатності — `unsupported` (UI: ціну й умови підтверджує продавець).
        """
        provider = next((p for p in self._providers if p.name == request.source), None)
        if provider is None or not hasattr(provider, "rates"):
            return StayRatesResult(status="unsupported")
        try:
            rates = await asyncio.wait_for(
                cast(StayRateSource, provider).rates(request.query, request.stay_id),
                timeout=self._timeout_s,
            )
        except ProviderUnsupportedError:
            return StayRatesResult(status="unsupported")
        except ProviderRateLimitedError:
            return StayRatesResult(status="rate_limited")
        except (TimeoutError, ProviderError) as exc:
            log.warning("stay_rates.failed", provider=request.source, error=type(exc).__name__)
            return StayRatesResult(status="error")
        if self._record_history and rates:
            await self._record_history(
                rate_rows(request.query, request.stay_id, provider.name, rates)
            )
        return StayRatesResult(
            status="ok",
            rooms=group_rates(rates),
            sellers=len({r.seller for r in rates}),
            checked_at=min((r.checked_at for r in rates), default=None),
            nights=request.query.nights,
        )

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
        except ProviderUnsupportedError as exc:
            # Не збій: джерело не рахує такий склад гостей (Google Hotels — лише на двох).
            return ProviderStatus(provider=name, status="unsupported", error=exc.message), []
        except ProviderError as exc:
            log.warning("stay_provider.error", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="error", error=exc.message), []
        except Exception:
            log.exception("stay_provider.unexpected_error", provider=name)
            return ProviderStatus(provider=name, status="error", error="internal error"), []
        return ProviderStatus(provider=name, status="ok", results=len(items)), items


def group_rates(rates: Sequence[StayRate]) -> list[RoomOffers]:
    """Групи однакових умов. Різні номери (код, або назва без коду), ліжка, харчування чи
    скасування — різні групи: дешевший тариф без сніданку не «перемагає» тариф зі сніданком.

    «Найдешевший» — лише серед рядків з відомою кінцевою сумою і лише коли їх хоча б два.
    """
    groups: dict[tuple[str, str | None, str | None, str | None], list[StayRate]] = {}
    for rate in rates:
        room = rate.room_code or f"name:{rate.room_name.strip().casefold()}"
        groups.setdefault((room, rate.bed_type, rate.meal, rate.cancellation), []).append(rate)

    def order(rate: StayRate) -> tuple[bool, Decimal, str]:
        final = rate.final_total
        return (final is None, final if final is not None else rate.price_total, rate.seller)

    rooms = []
    for key, items in groups.items():
        ordered = sorted(items, key=order)
        known = [r.final_total for r in ordered if r.final_total is not None]
        best = min(known) if len(known) > 1 else None
        rooms.append(
            RoomOffers(
                key="|".join(part or "" for part in key),
                room_name=ordered[0].room_name,
                bed_type=ordered[0].bed_type,
                meal=ordered[0].meal,
                cancellation=ordered[0].cancellation,
                offers=[
                    RateOffer(
                        rate=r,
                        final_total=r.final_total,
                        cheapest=best is not None and r.final_total == best,
                    )
                    for r in ordered
                ],
            )
        )
    # Спершу групи з кількома продавцями (там є що порівнювати), далі — від дешевшої.
    return sorted(
        rooms,
        key=lambda g: (
            len({o.rate.seller for o in g.offers}) < 2,
            g.offers[0].final_total
            if g.offers[0].final_total is not None
            else g.offers[0].rate.price_total,
        ),
    )


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
