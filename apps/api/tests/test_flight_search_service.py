from datetime import date
from typing import Any

from flight_fakes import StubProvider, day, offers_for
from tickets_api.domain.flights import FlightQuery, OfferFilters
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
)
from tickets_api.providers.budget import ProviderBudgetError
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService

QUERY = FlightQuery(origin="WAW", destination="LIS", departure_date=date(2026, 11, 10))


class HistorySpy:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def __call__(self, rows: list[dict[str, Any]]) -> None:
        self.rows += rows


def service(*providers: StubProvider, history: HistorySpy | None = None) -> FlightSearchService:
    return FlightSearchService(
        list(providers),
        timeout_s=0.2,
        scoring_config=default_scoring_config(),
        record_history=history,
    )


async def test_merges_providers_sorted_by_price_and_records_history() -> None:
    history = HistorySpy()
    svc = service(
        StubProvider("a", offers=offers_for("a", [300, 100])),
        StubProvider("b", offers=offers_for("b", [200])),
        history=history,
    )

    result = await svc.search(QUERY)

    assert [(o.source, int(o.price)) for o in result.offers] == [("a", 100), ("b", 200), ("a", 300)]
    assert {s.offer_key for s in result.scoring.scores} == {"a:a-0", "a:a-1", "b:b-0"}
    assert result.scoring.profile == "balanced"
    assert [(p.provider, p.status, p.results) for p in result.providers] == [
        ("a", "ok", 2),
        ("b", "ok", 1),
    ]
    assert len(history.rows) == 3
    assert history.rows[0]["kind"] == "offer"
    assert {r["source"] for r in history.rows} == {"a", "b"}


async def test_failing_or_slow_provider_does_not_break_search() -> None:
    svc = service(
        StubProvider("ok", offers=offers_for("ok", [100])),
        StubProvider("broken", error=ProviderError("broken", "HTTP 502")),
        StubProvider("slow", offers=offers_for("slow", [50]), delay_s=1),
        StubProvider("buggy", error=RuntimeError("secret internals")),
        StubProvider("quota", error=ProviderRateLimitedError("quota", "quota exhausted")),
        # Бюджет SkyPack (ADR 0055): запиту не було, джерело — як вичерпана квота.
        StubProvider("budget", error=ProviderBudgetError("budget", "SkyPack budget reached")),
    )

    result = await svc.search(QUERY)

    assert [o.source for o in result.offers] == ["ok"]
    statuses = {p.provider: (p.status, p.error) for p in result.providers}
    assert statuses == {
        "ok": ("ok", None),
        "broken": ("error", "HTTP 502"),
        "slow": ("timeout", "timeout"),
        "buggy": ("error", "internal error"),  # деталі не витікають назовні
        "quota": ("rate_limited", "quota exhausted"),
        "budget": ("rate_limited", "SkyPack budget reached"),
    }


async def test_calendar_keeps_cheapest_per_day_in_requested_currency() -> None:
    history = HistorySpy()
    svc = service(
        StubProvider("a", days=[day("a", 1, 120), day("a", 2, 90)]),
        StubProvider("b", days=[day("b", 1, 100), day("b", 3, 10, currency="UAH")]),
        history=history,
    )

    result = await svc.calendar("WAW", "LIS", date(2026, 11, 1), "eur")

    assert [(d.date.day, d.source, int(d.price)) for d in result.days] == [
        (1, "b", 100),
        (2, "a", 90),
    ]
    # В історію пишемо все отримане, навіть те, що не потрапило у відповідь.
    assert len(history.rows) == 4
    assert {r["kind"] for r in history.rows} == {"calendar_min"}


async def test_calendar_can_use_separate_providers() -> None:
    live = StubProvider("live", offers=offers_for("live", [100]))
    cached = StubProvider("cached", days=[day("cached", 1, 50)])
    svc = FlightSearchService(
        [live],
        calendar_providers=[cached],
        timeout_s=0.2,
        scoring_config=default_scoring_config(),
    )

    search = await svc.search(QUERY)
    calendar = await svc.calendar("WAW", "LIS", date(2026, 11, 1), "EUR")

    assert [p.provider for p in search.providers] == ["live"]
    assert [p.provider for p in calendar.providers] == ["cached"]
    assert (live.calls, cached.calls) == (1, 1)


async def test_provider_can_have_its_own_timeout() -> None:
    slow_but_allowed = StubProvider("live", offers=offers_for("live", [100]), delay_s=0.3)
    slow_but_allowed.timeout_s = 1.0  # type: ignore[attr-defined]
    svc = service(slow_but_allowed)  # загальний таймаут — 0.2 с

    result = await svc.search(QUERY)

    assert [p.status for p in result.providers] == ["ok"]


async def test_filters_apply_after_providers_and_history() -> None:
    history = HistorySpy()
    lo, fr = offers_for("a", [100, 150])
    fr = fr.model_copy(update={"airlines": ["FR"]})
    svc = FlightSearchService(
        [StubProvider("a", offers=[lo, fr])],
        timeout_s=0.2,
        scoring_config=default_scoring_config(),
        record_history=history,
        airline_names={"FR": "Ryanair"},
    )

    result = await svc.search(QUERY.model_copy(update={"filters": OfferFilters(airlines=["FR"])}))

    assert [o.airlines for o in result.offers] == [["FR"]]
    assert [s.offer_key for s in result.scoring.scores] == ["a:a-1"]  # скоринг — по видимих
    assert len(history.rows) == 2  # в історію — усе отримане
    assert result.facets.total_offers == 2
    assert [(f.code, f.name, f.offers) for f in result.facets.airlines] == [
        ("FR", "Ryanair", 1),
        ("LO", None, 1),
    ]


async def test_source_that_cannot_price_the_party_is_reported_not_guessed() -> None:
    history = HistorySpy()
    svc = service(
        StubProvider("live", offers=offers_for("live", [400])),
        StubProvider("cached", error=ProviderUnsupportedError("cached", "passengers")),
        history=history,
    )
    family = QUERY.model_copy(
        update={"passengers": {"adults": 2, "children": 1}, "cabin": "business"}
    )

    result = await svc.search(FlightQuery.model_validate(family.model_dump()))

    assert [o.source for o in result.offers] == ["live"]
    assert {p.provider: (p.status, p.error) for p in result.providers}["cached"] == (
        "unsupported",
        "passengers",
    )
    # В історії — за який склад і клас ця ціна: статистика не змішає її з ціною одного.
    assert {(r["party"], r["cabin"]) for r in history.rows} == {("2a1c0l0s", "business")}


async def test_budget_filter_is_per_passenger() -> None:
    svc = service(StubProvider("a", offers=offers_for("a", [250, 350])))
    query = FlightQuery.model_validate(
        {
            **QUERY.model_dump(),
            "passengers": {"adults": 2, "children": 1},
            "filters": OfferFilters(max_price=100).model_dump(),
        }
    )

    result = await svc.search(query)

    # 250 € за трьох ≤ 3 × 100 €, а 350 € — ні.
    assert [int(o.price) for o in result.offers] == [250]


async def test_baggage_costs_only_when_bags_are_needed() -> None:
    svc = service(StubProvider("a", offers=offers_for("a", [100, 200])))

    plain = await svc.search(QUERY)
    with_bags = await svc.search(QUERY.model_copy(update={"baggage": "checked"}))

    assert plain.baggage == {}
    assert set(with_bags.baggage) == {"a:a-0", "a:a-1"}
    # Джерело умов не дало — кінцева вартість невідома, а не «безкоштовно».
    assert {c.status for c in with_bags.baggage.values()} == {"unknown"}
