"""Модуль 22: пошук перельотів з кількох джерел — етапи, порівняння продавців, порядок за
порівнюваною вартістю, охоплення джерел."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from flight_fakes import COLLECTED_AT, StubProvider, offers_for
from tickets_api.domain.flights import (
    BagAllowance,
    Baggage,
    DatePair,
    FlightQuery,
    Offer,
    Segment,
)
from tickets_api.domain.freshness import FreshnessRules
from tickets_api.providers.base import ProviderError
from tickets_api.repositories.search_coverage import SearchCoverageRecorder, read_coverage
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import (
    FlightSearchService,
    SearchCoverage,
    flight_key,
    normalize_flight_number,
)
from tickets_api.services.ops import coverage_summary

QUERY = FlightQuery(origin="AMS", destination="WAW", departure_date=date(2026, 11, 10))
NOW = COLLECTED_AT + timedelta(minutes=5)


def flight(
    source: str, price: int, number: str, *, seller: str | None = None, **extra: Any
) -> Offer:
    base = offers_for(source, [price])[0]
    return base.model_copy(
        update={
            "id": f"{source}-{number}-{price}",
            "outbound": base.outbound.model_copy(update={"flight_number": number}),
            "seller": seller,
            "price_status": "live" if source == "live" else "cached",
            **extra,
        }
    )


def service(*providers: StubProvider, **kwargs: Any) -> FlightSearchService:
    return FlightSearchService(
        providers,
        timeout_s=0.5,
        scoring_config=default_scoring_config(),
        clock=lambda: NOW,
        **kwargs,
    )


def test_flight_numbers_from_different_sources_match() -> None:
    assert normalize_flight_number("LO 0437") == "LO437"
    assert normalize_flight_number("lo437") == "LO437"
    assert normalize_flight_number("W6 1475") == "W61475"
    assert normalize_flight_number("U2 1234") == "U21234"
    a = flight("live", 100, "KL 1361")
    b = flight("cached", 90, "KL1361")
    assert flight_key(a) == flight_key(b)


def test_connections_match_only_on_every_flight_number() -> None:
    """Контрольний пошук WAW→BCN: LX1349 + різні другі рейси (111 € і 189 €) злились в одну
    картку. Тепер ключ — усі рейси; без сегментів пересадку не ототожнюємо."""
    base = flight("live", 111, "LX 1349")
    leg = base.outbound
    first = Segment(
        origin="WAW",
        destination="ZRH",
        departure_at=leg.departure_at,
        arrival_at=leg.departure_at + timedelta(hours=2),
        carrier="LX",
        flight_number="LX 1349",
        duration_min=120,
    )

    def via(second: str) -> Offer:
        segment = first.model_copy(
            update={
                "origin": "ZRH",
                "destination": "LIS",
                "departure_at": first.arrival_at + timedelta(hours=1),
                "arrival_at": first.arrival_at + timedelta(hours=4),
                "flight_number": second,
            }
        )
        return base.model_copy(
            update={"outbound": leg.model_copy(update={"stops": 1, "segments": [first, segment]})}
        )

    assert flight_key(via("LX 2084")) != flight_key(via("LX 2088"))
    assert flight_key(via("LX 2084")) == "LX1349+LX2084@2026-11-10T06:00/1"
    summary = base.model_copy(update={"outbound": leg.model_copy(update={"stops": 1})})
    assert flight_key(summary) is None  # лише перший номер — маршрут невідомий


async def test_same_flight_from_all_sources_is_one_card_with_cheapest_first() -> None:
    live = StubProvider(
        "live",
        offers=[flight("live", 145, "KL 1361"), flight("live", 160, "LO 268")],
    )
    cached = StubProvider(
        "cached",
        live=False,
        offers=[
            flight("cached", 132, "KL1361", seller="Trip.com", found_on=NOW.date()),
            flight("cached", 139, "KL1361", seller="Kiwi.com", found_on=NOW.date()),
        ],
    )

    result = await service(live, cached).search(QUERY)

    assert (live.calls, cached.calls) == (1, 1)  # кожне джерело — один раз
    [group] = result.groups
    assert group.offer_keys == [
        "cached:cached-KL1361-132",
        "cached:cached-KL1361-139",
        "live:live-KL 1361-145",
    ]
    assert [int(o.price) for o in result.offers] == [132, 139, 145, 160]
    coverage = result.coverage
    assert coverage is not None
    assert [(s.provider, s.status, s.live, s.received, s.shown) for s in coverage.sources] == [
        ("live", "ok", True, 2, 2),
        ("cached", "ok", False, 2, 2),
    ]
    assert coverage.sellers == ["Kiwi.com", "Trip.com", "live"]
    assert (coverage.flights, coverage.multi_seller_flights, coverage.live_offers) == (2, 1, 2)


async def test_stale_price_leads_neither_the_card_nor_the_list() -> None:
    """Контрольний пошук AMS→WAW: кешована ціна віком понад 3 дні (111 €) стояла першою над
    живими (131 €) — у продавця вона вже інша. Тепер — після свіжих, з позначкою."""
    live = StubProvider(
        "live", offers=[flight("live", 145, "KL 1361"), flight("live", 160, "LO 268")]
    )
    stale = flight("cached", 99, "KL1361", seller="Kiwi.com", found_on=date(2026, 10, 1))
    stale_other = flight("cached", 90, "U2 3852", seller="Clickavia", found_on=date(2026, 10, 1))
    cached = StubProvider("cached", live=False, offers=[stale, stale_other])

    result = await service(live, cached, freshness=FreshnessRules()).search(QUERY)

    assert result.freshness["cached:cached-KL1361-99"] == "needs_recheck"
    assert [int(o.price) for o in result.offers] == [145, 160, 90, 99]
    [group] = result.groups
    assert group.offer_keys[0] == "live:live-KL 1361-145"  # перевірену — на картку
    assert group.offer_keys[1] == "cached:cached-KL1361-99"  # стара — серед продавців


async def test_order_uses_comparable_price_in_search_currency() -> None:
    pln = flight("live", 400, "LO 1", currency="PLN")  # 400 zł ≈ 93 € — дешевше за 100 €
    eur = flight("live", 100, "LO 2")
    nok = flight("live", 50, "LO 3", currency="NOK")  # курсу немає — не порівнюємо, в кінець
    rates = {("PLN", "EUR"): Decimal("0.2325")}

    async def fx(base: str, currency: str) -> Decimal | None:
        return rates.get((base, currency))

    result = await service(StubProvider("live", offers=[eur, nok, pln]), fx=fx).search(QUERY)

    assert [o.currency for o in result.offers] == ["PLN", "EUR", "NOK"]
    assert result.offers[0].price == 400  # вихідна ціна лишається у видачі


async def test_order_includes_known_baggage_and_puts_unknown_last() -> None:
    def bags(fee: int | None) -> Baggage:
        status = "included" if fee == 0 else "fee"
        return Baggage(
            personal_item=BagAllowance(status="included"),
            carry_on=BagAllowance(status=status, fee=None if fee is None else Decimal(fee)),
        )

    cheap_bag_extra = flight("live", 80, "FR 1", baggage=bags(40))  # 120 з багажем
    included = flight("live", 110, "LO 2", baggage=bags(0))  # 110
    unknown = flight("live", 60, "W6 3", baggage=None)  # кінцева вартість невідома

    result = await service(
        StubProvider("live", offers=[cheap_bag_extra, included, unknown])
    ).search(QUERY.model_copy(update={"baggage": "carry_on"}))

    assert [int(o.price) for o in result.offers] == [110, 80, 60]


async def test_flexible_search_asks_cached_search_source_once_for_dates() -> None:
    d = date(2026, 12, 5)
    candidate = flight("cached", 70, "KL1361", found_on=NOW.date())
    candidate = candidate.model_copy(
        update={
            "outbound": candidate.outbound.model_copy(
                update={"departure_at": datetime(2026, 12, 5, 6, tzinfo=UTC)}
            )
        }
    )
    cached = StubProvider("cached", live=False, offers=[candidate])
    live = StubProvider("live", offers=[])
    svc = FlightSearchService(
        [live, cached],
        calendar_providers=[cached],
        timeout_s=0.5,
        scoring_config=default_scoring_config(),
        clock=lambda: NOW,
    )

    result = await svc.search(QUERY.model_copy(update={"departure_date": d, "flex_days": 3}))

    assert cached.calls == 1  # відповідь розвідки — вже пропозиції пошуку
    [checked] = live.queries
    assert checked.check_dates == [DatePair(departure=d, return_date=None)]
    [option] = result.date_options
    assert option.verified is False  # лише кешована ціна, живе джерело її не підтвердило


async def test_one_failed_source_keeps_the_others_and_is_visible_in_coverage() -> None:
    broken = StubProvider("live", error=ProviderError("live", "boom"))
    cached = StubProvider(
        "cached", live=False, offers=[flight("cached", 90, "KL1361", found_on=NOW.date())]
    )

    result = await service(broken, cached).search(QUERY)

    assert [int(o.price) for o in result.offers] == [90]
    assert result.coverage is not None
    assert [(s.provider, s.status) for s in result.coverage.sources] == [
        ("live", "error"),
        ("cached", "ok"),
    ]


class PipelineRedis:
    """Мінімальний Redis для лічильників: hincrby/expire через pipeline і hgetall."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[bytes, bytes]] = {}

    def pipeline(self, transaction: bool = True) -> "PipelineRedis":
        return self

    def hincrby(self, key: str, field: str, amount: int) -> None:
        bucket = self.hashes.setdefault(key, {})
        bucket[field.encode()] = str(int(bucket.get(field.encode(), b"0")) + amount).encode()

    def expire(self, key: str, seconds: int) -> None:
        pass

    async def execute(self) -> None:
        pass

    async def hgetall(self, key: str) -> dict[bytes, bytes]:
        return self.hashes.get(key, {})


async def test_coverage_counters_feed_the_ops_summary() -> None:
    redis = PipelineRedis()
    recorder = SearchCoverageRecorder(redis, clock=lambda: NOW)  # type: ignore[arg-type]
    live = StubProvider("live", offers=[flight("live", 145, "KL 1361")])
    cached = StubProvider(
        "cached", live=False, offers=[flight("cached", 132, "KL1361", found_on=NOW.date())]
    )
    svc = service(live, cached, record_coverage=recorder.record)
    await svc.search(QUERY)
    await svc.search(QUERY)

    summary = coverage_summary(await read_coverage(redis, NOW))  # type: ignore[arg-type]

    assert summary.searches_7d == 2
    assert summary.multi_seller_flights_7d == 2
    assert summary.sources["cached"].statuses == {"ok": 2}
    assert (summary.sources["live"].received, summary.sources["live"].shown) == (2, 2)


def test_coverage_log_has_no_route_or_dates() -> None:
    coverage = SearchCoverage(
        sources=[], sellers=["Kiwi.com"], flights=1, multi_seller_flights=0, live_offers=0
    )
    assert set(coverage.log_fields()) == {
        "sources",
        "sellers",
        "flights",
        "multi_seller_flights",
        "live_offers",
    }
