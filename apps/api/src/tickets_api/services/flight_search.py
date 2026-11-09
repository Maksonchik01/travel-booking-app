"""Агрегація провайдерів перельотів з graceful degradation.

Кожен провайдер опитується паралельно з власним таймаутом. Помилка чи таймаут одного
не ламають відповідь: повертаємо те, що отримали, і статус кожного джерела.
"""

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal, cast

import structlog
from pydantic import BaseModel

from tickets_api.domain.flights import (
    MAX_NIGHTS,
    CalendarDay,
    DatePair,
    FilterCode,
    FlightQuery,
    Money,
    Offer,
    stay_nights,
)
from tickets_api.domain.freshness import FreshnessRules, PriceFreshness, price_freshness
from tickets_api.domain.money import ConvertedPrice, convert, converted
from tickets_api.domain.sellers import SellersRequest, SellersResult
from tickets_api.providers.base import (
    FlightProvider,
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
    SellerSource,
)
from tickets_api.repositories.price_history import calendar_rows, offer_rows
from tickets_api.scoring.baggage import BaggageCost, baggage_cost
from tickets_api.scoring.config import ScoringConfig
from tickets_api.scoring.engine import ScoringResult, offer_key, score_offers

log = structlog.get_logger(__name__)

RecordHistory = Callable[[list[dict[str, Any]]], Awaitable[None]]
RateLookup = Callable[[str, str], Awaitable[Decimal | None]]
"""(база, валюта) → одиниць валюти за одиницю бази; None — курсу немає."""


class ProviderStatus(BaseModel):
    provider: str
    status: Literal["ok", "error", "timeout", "rate_limited", "unsupported"]
    """rate_limited — вичерпано квоту/ліміт запитів джерела (UI пояснює це окремо);
    unsupported — джерело не рахує такий склад пасажирів чи клас (`error` — passengers | cabin)."""
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


ExclusionReason = Literal[FilterCode, "direct", "baggage"]


class Exclusion(BaseModel):
    """Скільки пропозицій відсіяно обов'язковою вимогою (модуль 14.1) — за першою порушеною."""

    reason: ExclusionReason
    offers: int


def requirement_violations(offer: Offer, query: FlightQuery) -> list[ExclusionReason]:
    """Обов'язкові вимоги користувача: «лише прямі», фільтри видачі, потрібний багаж, якого
    тариф не дозволяє. Порушив хоч одну — пропозиція не ранжується й не рекомендується, хоч
    би якою дешевою була. Невідоме (тривалість, умови багажу) не порушує (ADR 0004)."""
    failed: list[ExclusionReason] = []
    if query.direct_only and offer.stops > 0:
        failed.append("direct")
    failed.extend(query.filters.violations(offer, passengers=query.passengers.total))
    if (
        query.baggage != "none"
        and baggage_cost(offer, query.baggage, query.passengers).status == "not_available"
    ):
        failed.append("baggage")
    return failed


class DateOption(BaseModel):
    departure: date
    return_date: date | None
    price: Money
    currency: str
    verified: bool
    """Ціну на ці дати перевірило живе джерело в цьому пошуку; False — лише кешована."""
    found_at: datetime | None
    """Коли джерело знайшло найдешевшу ціну; None — невідомо (див. found_on)."""
    found_on: date | None
    """День знаходження, якщо відомий лише день (кешовані джерела)."""
    offers: int
    nights: int | None = None
    """Ночей на місці (туди-назад): від прильоту туди до вильоту назад."""
    nights_approximate: bool = False
    """Прибуття невідоме — ночі пораховано від дати вильоту (може бути на одну менше)."""


class OfferGroup(BaseModel):
    key: str
    """Рейс: перший номер рейсу, час вильоту й пересадки в кожному напрямку."""
    offer_keys: list[str]
    """Від найдешевшої; умови тарифів можуть відрізнятися — UI показує їх у кожному рядку."""


class FlightSearchResult(BaseModel):
    offers: list[Offer]
    """Лише ті, що пройшли обов'язкові вимоги (`requirement_violations`); скоринг — по них же."""
    providers: list[ProviderStatus]
    excluded: list[Exclusion] = []
    """Що відсіяли обов'язкові вимоги — щоб UI чесно сказав, скільки й чому приховано."""
    scoring: ScoringResult
    facets: SearchFacets
    baggage: dict[str, BaggageCost] = {}
    groups: list[OfferGroup] = []
    """Той самий рейс від кількох джерел/продавців (модуль 3): одна картка, рядки продавців."""
    date_options: list[DateOption] = []
    """Гнучкі дати: найкраща ціна на кожну пару дат серед показаних пропозицій."""
    converted: dict[str, ConvertedPrice] = {}
    """offer_key → ціна у валюті пошуку, якщо джерело дало іншу валюту (модуль 18.2): для
    порівняння, орієнтовно. Скоринг, «найдешевший», багаж і гнучкі дати — у валюті пошуку."""
    freshness: dict[str, PriceFreshness] = {}
    """offer_key → свіжість ціни на момент відповіді (модуль 17.3): live / cached /
    approximate / needs_recheck. Час отримання — `Offer.collected_at` / `found_at`."""
    """offer_key → вартість з потрібним багажем (`query.baggage`); порожньо — багаж не потрібен."""


class MatrixCell(BaseModel):
    departure: date
    return_date: date
    price: Money
    """Загальна ціна туди-назад за одного дорослого (кешована, орієнтовна)."""
    currency: str
    stops: int
    source: str
    found_at: datetime | None
    found_on: date | None


class PriceMatrix(BaseModel):
    """Матриця туди-назад (модуль 2c): виліт × повернення, лише кешовані джерела календаря."""

    departures: list[date]
    returns: list[date]
    cells: list[MatrixCell]
    providers: list[ProviderStatus]


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
        fx: RateLookup | None = None,
        live_date_pairs: int = 2,
        freshness: FreshnessRules | None = None,
        clock: Callable[[], datetime] | None = None,
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
        self._fx = fx
        self._live_date_pairs = live_date_pairs
        self._freshness = freshness or FreshnessRules()
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def airline_names(self) -> Mapping[str, str]:
        return self._airline_names

    async def search(self, query: FlightQuery) -> FlightSearchResult:
        explored, live_query = await self._explore(query)
        results = explored + await self._gather(self._providers, lambda p: p.search(live_query))
        # Ночі рахуємо за фактичним прильотом — і для живих пропозицій (нічний рейс).
        unique = {
            (o.source, o.id): o for _, items in results for o in items if _fits_trip(o, query)
        }
        offers = sorted(unique.values(), key=lambda o: (o.price, o.source, o.id))
        if self._record_history:
            # В історію — усе отримане, фільтри видачі її не стосуються.
            await self._record_history(
                offer_rows(
                    query.origin,
                    query.destination,
                    offers,
                    party=query.passengers.code,
                    cabin=query.cabin,
                )
            )
        # Спершу обов'язкові вимоги (відсікаємо), потім ранжування решти (модуль 14.1).
        violations = {offer_key(o): requirement_violations(o, query) for o in offers}
        shown = [o for o in offers if not violations[offer_key(o)]]
        # Одна валюта порівняння — валюта пошуку; вихідні ціни лишаються у видачі (18.2).
        comparable, conversions = await self._in_currency(shown, query.currency)
        excluded = Counter(failed[0] for failed in violations.values() if failed)
        baggage = (
            {offer_key(o): baggage_cost(o, query.baggage, query.passengers) for o in comparable}
            if query.baggage != "none"
            else {}
        )
        return FlightSearchResult(
            offers=shown,
            providers=[s for s, _ in results],
            # «Найшвидший» і мінімальний час — серед того, що користувач бачить.
            scoring=score_offers(
                comparable,
                query.profile,
                await self._config_for(query.currency),
                travellers=query.passengers.seated,
                baggage=baggage,
                preferences=query.preferences,
            ),
            converted=conversions,
            freshness=self.freshness(shown),
            excluded=[
                Exclusion(reason=reason, offers=n)
                for reason, n in sorted(excluded.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
            baggage=baggage,
            facets=self._facets(offers),
            groups=offer_groups(shown),
            date_options=(
                date_options(comparable, live={p.name for p in self._providers})
                if query.is_flexible
                else []
            ),
        )

    def freshness(self, offers: Sequence[Offer]) -> dict[str, PriceFreshness]:
        now = self._clock()
        return {
            offer_key(o): price_freshness(
                live=o.price_status == "live",
                collected_at=o.collected_at,
                found_at=o.found_at,
                found_on=o.found_on,
                now=now,
                rules=self._freshness,
            )
            for o in offers
        }

    async def _explore(
        self, query: FlightQuery
    ) -> tuple[list[tuple[ProviderStatus, list[Offer]]], FlightQuery]:
        """Гнучкі дати (ADR 0016): кешовані джерела календаря безкоштовно дають кандидатів на все
        вікно, а живі джерела перевіряють лише найдешевші пари дат (`check_dates`)."""
        own = {p.name for p in self._providers}
        explorers = [p for p in self._calendar_providers if p.name not in own]
        if not query.is_flexible or not explorers or self._live_date_pairs == 0:
            return [], query
        explored = await self._gather(explorers, lambda p: p.search(query))
        candidates = [o for _, items in explored for o in items if _fits_trip(o, query)]
        explored = [
            (status, [o for o in items if _fits_trip(o, query)]) for status, items in explored
        ]
        pairs = best_date_pairs(candidates, query, limit=self._live_date_pairs)
        return explored, query.model_copy(update={"check_dates": pairs}) if pairs else query

    async def rate(self, base: str, currency: str) -> Decimal | None:
        """Довідковий курс ЄЦБ: одиниць `currency` за 1 `base`. Немає — None (не вгадуємо)."""
        if base == currency:
            return Decimal(1)
        if self._fx is None:
            return None
        try:
            return await self._fx(base, currency)
        except Exception:
            log.exception("fx.rate_failed")
            return None

    async def _config_for(self, currency: str) -> ScoringConfig:
        """Ваги скорингу у валюті пошуку (курс ЄЦБ). Без курсу — базові: пропозиції в іншій
        валюті тоді не оцінюються (`unscored_offer_keys`), а не порівнюються навмання."""
        base = self._scoring_config
        rate = await self.rate(base.currency, currency)
        return base.in_currency(currency, rate) if rate else base

    async def _in_currency(
        self, offers: Sequence[Offer], currency: str
    ) -> tuple[list[Offer], dict[str, ConvertedPrice]]:
        """Копії для порівняння у валюті пошуку + що й за яким курсом переведено. Без курсу
        пропозиція лишається у своїй валюті — скоринг її чесно не оцінить."""
        rates = {c: await self.rate(c, currency) for c in {o.currency for o in offers} - {currency}}
        result: list[Offer] = []
        conversions: dict[str, ConvertedPrice] = {}
        for offer in offers:
            rate = rates.get(offer.currency)
            if offer.currency == currency or rate is None:
                result.append(offer)
                continue
            conversions[offer_key(offer)] = converted(offer.price, offer.currency, currency, rate)
            result.append(offer_in_currency(offer, currency, rate))
        return result, conversions

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

    async def matrix(
        self,
        origin: str,
        destination: str,
        departures: tuple[date, date],
        returns: tuple[date, date],
        currency: str,
    ) -> PriceMatrix:
        """Ціни на кожну пару «виліт × повернення» з кешованих джерел календаря: кілька запитів
        на місяці (і ті кешуються в Redis), жодного живого — квоту не витрачаємо."""
        start, end = departures
        query = FlightQuery(
            origin=origin,
            destination=destination,
            departure_date=start,
            departure_until=end,
            return_date=start + timedelta(days=1),
            min_nights=1,
            max_nights=MAX_NIGHTS,
            currency=currency,
        )
        results = await self._gather(self._calendar_providers, lambda p: p.search(query))
        best: dict[tuple[date, date], Offer] = {}
        for _, items in results:
            for o in items:
                if o.inbound is None or o.currency != query.currency:
                    continue
                dep, ret = _dates(o)
                if ret is None or not (start <= dep <= end and returns[0] <= ret <= returns[1]):
                    continue
                if (dep, ret) not in best or o.price < best[(dep, ret)].price:
                    best[(dep, ret)] = o
        return PriceMatrix(
            departures=_days(start, end),
            returns=_days(*returns),
            cells=[
                MatrixCell(
                    departure=dep,
                    return_date=ret,
                    price=o.price,
                    currency=o.currency,
                    stops=o.stops,
                    source=o.source,
                    found_at=o.found_at,
                    found_on=o.found_on,
                )
                for (dep, ret), o in sorted(best.items())
            ],
            providers=[s for s, _ in results],
        )

    async def sellers(self, request: SellersRequest) -> SellersResult:
        """Продавці рейсу й свіжа ціна в кожного (модуль 3b/3c). Джерело без такої здатності —
        `unsupported`: тоді UI пише, що остаточну ціну підтверджує продавець."""
        provider = next(
            (p for p in self._providers if p.name == request.source),
            None,
        )
        if provider is None or not isinstance(provider, SellerSource):
            return SellersResult(status="unsupported")
        status, sellers = await self._call(
            provider, lambda p: cast(SellerSource, p).sellers(request.query, request.booking_ref)
        )
        if status.status != "ok":
            if status.status in ("rate_limited", "unsupported"):
                return SellersResult(status=status.status)
            return SellersResult(status="error")
        ordered = sorted(sellers, key=lambda s: (s.price, not s.is_airline, s.seller))
        return SellersResult(
            status="ok",
            sellers=ordered,
            checked_at=min((s.checked_at for s in ordered), default=None),
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
        except ProviderUnsupportedError as exc:
            log.info("provider.unsupported", provider=name, reason=exc.message)
            return ProviderStatus(provider=name, status="unsupported", error=exc.message), []
        except ProviderError as exc:
            log.warning("provider.error", provider=name, error=exc.message)
            return ProviderStatus(provider=name, status="error", error=exc.message), []
        except Exception:
            # Неочікуване — у лог і Sentry з трасою, назовні — без деталей.
            log.exception("provider.unexpected_error", provider=name)
            return ProviderStatus(provider=name, status="error", error="internal error"), []
        return ProviderStatus(provider=name, status="ok", results=len(items)), items


def offer_in_currency(offer: Offer, currency: str, rate: Decimal) -> Offer:
    """Та сама пропозиція з ціною й доплатами за багаж у валюті порівняння (лише для оцінки)."""
    bags = offer.baggage
    if bags is not None:
        bags = bags.model_copy(
            update={
                kind: allowance.model_copy(update={"fee": convert(allowance.fee, rate)})
                for kind in ("personal_item", "carry_on", "checked", "checked_extra")
                if (allowance := getattr(bags, kind)) is not None and allowance.fee is not None
            }
        )
    return offer.model_copy(
        update={"price": convert(offer.price, rate), "currency": currency, "baggage": bags}
    )


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


MAX_DATE_OPTIONS = 20
TRIP_LENGTH_TOLERANCE_DAYS = 1


def _fits_trip(offer: Offer, query: FlightQuery) -> bool:
    """Ночі (2b): у межах від–до за фактичною датою прильоту; орієнтовні (прибуття невідоме,
    справжніх ночей n або n−1) — якщо діапазон перетинається. Період без ночей: та сама
    тривалість поїздки (±1 день)."""
    if offer.inbound is None:
        return True
    if query.nights_range is not None:
        low, high = query.nights_range
        nights, approximate = stay_nights(offer.outbound, offer.inbound)
        return low <= nights <= high or (approximate and low <= nights - 1 <= high)
    if query.departure_until is None or query.trip_days is None:
        return True
    days = (offer.inbound.departure_at.date() - offer.outbound.departure_at.date()).days
    return abs(days - query.trip_days) <= TRIP_LENGTH_TOLERANCE_DAYS


def _dates(offer: Offer) -> tuple[date, date | None]:
    """Дати вильоту в місцевому часі аеропорту (як у пошуку)."""
    return (
        offer.outbound.departure_at.date(),
        offer.inbound.departure_at.date() if offer.inbound else None,
    )


def best_date_pairs(offers: Sequence[Offer], query: FlightQuery, *, limit: int) -> list[DatePair]:
    """Найдешевші різні пари дат серед кандидатів, що пройшли б фільтри видачі."""
    best: dict[tuple[date, date | None], Decimal] = {}
    for o in offers:
        if requirement_violations(o, query):
            continue
        key = _dates(o)
        if key not in best or o.price < best[key]:
            best[key] = o.price
    ranked = sorted(best.items(), key=lambda kv: (kv[1], kv[0][0]))[:limit]
    return [DatePair(departure=dep, return_date=ret) for (dep, ret), _ in ranked]


def date_options(offers: Sequence[Offer], *, live: set[str]) -> list[DateOption]:
    groups: dict[tuple[date, date | None], list[Offer]] = {}
    for o in offers:
        groups.setdefault(_dates(o), []).append(o)
    options = []
    for (dep, ret), items in groups.items():
        cheapest = min(items, key=lambda o: o.price)
        nights, approximate = (
            stay_nights(cheapest.outbound, cheapest.inbound) if cheapest.inbound else (None, False)
        )
        options.append(
            DateOption(
                departure=dep,
                return_date=ret,
                price=cheapest.price,
                currency=cheapest.currency,
                verified=any(o.source in live for o in items),
                found_at=cheapest.found_at,
                found_on=cheapest.found_on,
                offers=len(items),
                nights=nights,
                nights_approximate=approximate,
            )
        )
    return sorted(options, key=lambda d: (d.price, d.departure))[:MAX_DATE_OPTIONS]


def _days(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def flight_key(offer: Offer) -> str | None:
    """Ключ однакового рейсу між джерелами: перший номер рейсу, місцевий час вильоту до хвилини
    й кількість пересадок у кожному напрямку. Без номера рейсу — не групуємо (не вгадуємо)."""
    parts = []
    for leg in (offer.outbound, offer.inbound):
        if leg is None:
            continue
        number = leg.segments[0].flight_number if leg.segments else leg.flight_number
        if not number:
            return None
        when = leg.departure_at.strftime("%Y-%m-%dT%H:%M")
        parts.append(f"{number.replace(' ', '').upper()}@{when}/{leg.stops}")
    return "|".join(parts)


def offer_groups(offers: Sequence[Offer]) -> list[OfferGroup]:
    groups: dict[str, list[Offer]] = {}
    for o in offers:
        key = flight_key(o)
        if key is not None:
            groups.setdefault(key, []).append(o)
    return [
        OfferGroup(
            key=key,
            offer_keys=[offer_key(o) for o in sorted(items, key=lambda o: (o.price, o.source))],
        )
        for key, items in groups.items()
        if len(items) > 1
    ]
