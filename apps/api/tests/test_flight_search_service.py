from datetime import date
from typing import Any

from flight_fakes import StubProvider, day, offers_for
from tickets_api.domain.flights import FlightQuery, OfferFilters
from tickets_api.providers.base import ProviderError, ProviderRateLimitedError
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
