"""Скоринг на еталонних наборах (tests/fixtures/scoring/*.json).

Очікувані значення пораховані вручну за формулою з tickets_api/scoring/config.toml —
якщо змінюєте ваги чи штрафи, перераховуйте еталони свідомо, а не «щоб пройшло».
"""

import json
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from tickets_api.domain.flights import Layover, Leg, Offer
from tickets_api.scoring.config import default_scoring_config
from tickets_api.scoring.engine import ScoringResult, score_offers

FIXTURES = sorted((Path(__file__).parent / "fixtures" / "scoring").glob("*.json"))
COLLECTED_AT = datetime.fromisoformat("2026-11-01T12:00:00+00:00")


def build_leg(raw: dict[str, Any], origin: str, destination: str) -> Leg:
    departure = datetime.fromisoformat(raw["departure_at"])
    layovers = raw["layovers"]
    return Leg(
        origin=origin,
        destination=destination,
        departure_at=departure,
        arrival_at=departure + timedelta(minutes=raw["duration_min"])
        if raw["duration_min"] is not None
        else None,
        duration_min=raw["duration_min"],
        stops=raw["stops"],
        layovers=None
        if layovers is None
        else [
            Layover(airport=a, duration_min=m, overnight=o, self_transfer=s)
            for a, m, o, s in layovers
        ],
    )


def build_offer(raw: dict[str, Any]) -> Offer:
    return Offer(
        id=raw["id"],
        source="ref",
        price=Decimal(raw["price"]),
        currency="EUR",
        outbound=build_leg(raw["outbound"], "WAW", "LIS"),
        inbound=build_leg(raw["inbound"], "LIS", "WAW") if "inbound" in raw else None,
        airlines=["XX"],
        details_level="full",
        baggage_included=raw["baggage_included"],
        collected_at=COLLECTED_AT,
    )


def _dec(value: str | None) -> Decimal | None:
    return None if value is None else Decimal(value)


def _id(key: str) -> str:
    return key.removeprefix("ref:")


@pytest.mark.parametrize("path", FIXTURES, ids=[p.stem for p in FIXTURES])
def test_reference_dataset(path: Path) -> None:
    case = json.loads(path.read_text())
    offers = [build_offer(o) for o in case["offers"]]

    result: ScoringResult = score_offers(offers, case["profile"], default_scoring_config())

    expected = case["expected"]
    assert result.min_duration_min == expected["min_duration_min"]
    scores = {_id(s.offer_key): s for s in result.scores}
    for offer_id, exp in expected["breakdowns"].items():
        b = scores[offer_id].breakdown
        actual = {
            "time_penalty": b.time_penalty,
            "stop_penalty": b.stop_penalty,
            "risk_total": b.risk_total,
            "total": b.total,
        }
        assert actual == {k: _dec(exp[k]) for k in actual}, offer_id
        if "risks" in exp:
            risks = [[p.code, p.leg, p.airport] for p in b.risk_penalties]
            assert risks == exp["risks"], offer_id
        if "warnings" in exp:
            warnings = [[w.code, w.leg, w.airport] for w in scores[offer_id].warnings]
            assert warnings == exp["warnings"], offer_id
    assert sorted(i for i, s in scores.items() if s.pareto_optimal) == sorted(expected["pareto"])
    assert [
        {"label": p.label, "id": _id(p.offer_key), "also": p.also} for p in result.picks
    ] == expected["picks"]


def test_fixtures_exist() -> None:
    assert len(FIXTURES) >= 8
