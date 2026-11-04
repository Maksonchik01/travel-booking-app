from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError
from tickets_api.domain.flights import Layover, Leg, Offer
from tickets_api.scoring.config import default_scoring_config, load_scoring_config
from tickets_api.scoring.engine import score_offers

CONFIG = default_scoring_config()
T = datetime(2026, 11, 10, 10, 0, tzinfo=UTC)


def offer(
    id_: str = "x",
    *,
    price: int = 100,
    departure: datetime = T,
    duration: int | None = 300,
    layovers: list[Layover] | None = None,
    stops: int | None = None,
    currency: str = "EUR",
    baggage: bool | None = True,
) -> Offer:
    n_stops = stops if stops is not None else len(layovers or [])
    return Offer(
        id=id_,
        source="t",
        price=Decimal(price),
        currency=currency,
        outbound=Leg(
            origin="WAW",
            destination="LIS",
            departure_at=departure,
            arrival_at=departure + timedelta(minutes=duration) if duration else None,
            duration_min=duration,
            stops=n_stops,
            layovers=layovers if layovers is not None or stops is None else None,
        ),
        airlines=["XX"],
        details_level="full",
        baggage_included=baggage,
        collected_at=T,
    )


def layover(minutes: int, *, overnight: bool = False, self_transfer: bool = False) -> Layover:
    return Layover(
        airport="FRA", duration_min=minutes, overnight=overnight, self_transfer=self_transfer
    )


def risk_codes(o: Offer) -> list[str]:
    [score] = score_offers([o], "balanced", CONFIG).scores
    return [p.code for p in score.breakdown.risk_penalties]


def warning_codes(o: Offer) -> list[str]:
    [score] = score_offers([o], "balanced", CONFIG).scores
    return [w.code for w in score.warnings]


@pytest.mark.parametrize(("minutes", "short"), [(59, True), (60, False), (61, False)])
def test_short_layover_threshold(minutes: int, short: bool) -> None:
    assert ("short_layover" in risk_codes(offer(layovers=[layover(minutes)]))) is short


@pytest.mark.parametrize(("minutes", "long"), [(480, False), (481, True)])
def test_long_layover_is_only_a_warning(minutes: int, long: bool) -> None:
    o = offer(layovers=[layover(minutes)])
    assert ("long_layover" in warning_codes(o)) is long
    assert risk_codes(o) == []


@pytest.mark.parametrize(
    ("local", "night"),
    [("2026-11-10T00:00:00+02:00", True), ("2026-11-10T05:59:00+02:00", True),
     ("2026-11-10T06:00:00+02:00", False), ("2026-11-10T23:59:00+02:00", False)],
)  # fmt: skip
def test_night_departure_uses_airport_local_time(local: str, night: bool) -> None:
    # 05:59 за місцевим часом — це 03:59 UTC; важливий саме місцевий час.
    o = offer(departure=datetime.fromisoformat(local))
    assert ("night_departure" in risk_codes(o)) is night


def test_each_risky_layover_is_penalised_separately() -> None:
    o = offer(
        layovers=[layover(45, self_transfer=True), layover(200, overnight=True, self_transfer=True)]
    )
    [score] = score_offers([o], "balanced", CONFIG).scores

    assert [p.code for p in score.breakdown.risk_penalties] == [
        "short_layover",
        "self_transfer",
        "overnight_layover",
        "self_transfer",
    ]
    assert score.breakdown.risk_total == Decimal("170.00")  # 40 + 50 + 30 + 50


def test_unknown_layover_details_only_warn() -> None:
    o = offer(stops=1, layovers=None)

    assert risk_codes(o) == []
    assert warning_codes(o) == ["layover_details_unknown"]


def test_baggage_never_changes_cost() -> None:
    with_bag = offer("a", baggage=True)
    without = offer("b", baggage=False)

    scores = score_offers([with_bag, without], "balanced", CONFIG).scores

    assert scores[0].breakdown.total == scores[1].breakdown.total


def test_other_currency_is_not_scored() -> None:
    result = score_offers([offer("eur"), offer("uah", currency="UAH")], "balanced", CONFIG)

    assert [s.offer_key for s in result.scores] == ["t:eur"]
    assert result.unscored_offer_keys == ["t:uah"]


def test_empty_input() -> None:
    result = score_offers([], "budget", CONFIG)

    assert (result.scores, result.picks, result.min_duration_min) == ([], [], None)


def test_ties_prefer_fewer_stops() -> None:
    a = offer("a", stops=1, layovers=[layover(90)])
    b = offer("b")

    [pick] = score_offers([a, b], "balanced", CONFIG).picks

    assert (pick.offer_key, pick.label) == ("t:b", "balanced")


def test_default_config_has_expected_shape() -> None:
    assert CONFIG.currency == "EUR"
    assert set(CONFIG.profiles) == {"budget", "balanced", "time_is_money"}
    assert all(isinstance(w.lambda_stop, Decimal) for w in CONFIG.profiles.values())


def test_invalid_config_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "scoring.toml"
    path.write_text(
        'currency = "EUR"\n[profiles.budget]\nlambda_time_per_hour = 5\nlambda_stop = 10\n'
        "[penalties]\nshort_layover = 1\novernight_layover = 1\nself_transfer = 1\n"
        "night_departure = 1\n[thresholds]\nshort_layover_min = 60\nlong_layover_min = 480\n"
        "night_start_hour = 0\nnight_end_hour = 6\n"
    )

    with pytest.raises(ValidationError, match="бракує профілів"):
        load_scoring_config(path)
