"""Вхідні дані про житло для моделі: готові тексти чисел, щоб модель нічого не рахувала.

Спільне для агента (інструмент search_stays) і аналітика відгуків (Stay-Analyst).
"""

from decimal import Decimal
from typing import Any

from tickets_api.ai.explainer import money_text
from tickets_api.domain.stays import Stay, StayQuery
from tickets_api.i18n import Labels, t
from tickets_api.scoring.stays import StayPick, StayScore, stay_key
from tickets_api.services.stay_search import StaySearchResult

STAY_TITLES = Labels("ai.stay_label", ("cheapest", "top_rated", "balanced"))
"""Ті самі назви, що в UI (stayPicks.label), мовою розмови (модуль 18.1)."""


def stay_query_input(query: StayQuery) -> dict[str, Any]:
    return {
        "city": query.city,
        "check_in": query.check_in.isoformat(),
        "check_out": query.check_out.isoformat(),
        "nights": query.nights,
        "adults": query.guests.adults,
        "children": query.guests.children,
        "priority": query.profile,
        "budget_per_night": query.filters.max_price_per_night,
    }


def stay_options_input(query: StayQuery, result: StaySearchResult) -> dict[str, Any]:
    """До трьох рекомендованих скорингом варіантів + готові порівняння між ними."""
    stays = {stay_key(s): s for s in result.stays}
    scores = {s.stay_key: s for s in result.scoring.scores}
    picks = [p for p in result.scoring.picks if p.stay_key in stays]
    options = [stay_option(p, stays[p.stay_key], scores.get(p.stay_key)) for p in picks]
    comparisons = [
        _compare(a, stays[pa.stay_key], b, stays[pb.stay_key])
        for i, (pa, a) in enumerate(zip(picks, options, strict=True))
        for pb, b in list(zip(picks, options, strict=True))[i + 1 :]
    ]
    return {
        "query": {
            **stay_query_input(query),
            "city_name": result.place.name if result.place else query.city,
        },
        "options": options,
        "recommended_by_scoring": recommended_stay(picks),
        "comparisons": comparisons,
        "stays_found": len(result.stays),
        "sources_failed": [p.provider for p in result.providers if p.status != "ok"],
        "prices_are": "with taxes, for the whole room",
    }


def recommended_stay(picks: list[StayPick]) -> str | None:
    """Найкраща оцінка для пріоритету — «balanced»; без нього — перший із наявних."""
    labels = [p.label for p in picks]
    return "balanced" if "balanced" in labels else (labels[0] if labels else None)


def stay_option(pick: StayPick, stay: Stay, score: StayScore | None) -> dict[str, Any]:
    return {
        "id": pick.label,
        "title": STAY_TITLES[pick.label],
        "also": [STAY_TITLES[label] for label in pick.also],
        **stay_facts(stay),
        "warnings": [w.code for w in (score.warnings if score else [])],
    }


def stay_facts(stay: Stay) -> dict[str, Any]:
    """Факти про об'єкт текстом. null — невідомо (а не «немає»)."""
    return {
        "name": stay.name,
        "kind": stay.kind,
        "stars": stay.stars,
        "district": stay.district,
        "price_per_night_text": money_text(stay.price_per_night, stay.currency),
        "total_price_text": money_text(stay.total_price, stay.currency),
        "nights": stay.nights,
        "rating_text": t("ai.stay.rating", rating=stay.rating) if stay.rating is not None else None,
        "review_count": stay.review_count,
        "distance_to_center_text": _km(stay.distance_to_center_km),
        "distance_to_transit_text": t("ai.stay.meters", value=stay.distance_to_transit_m)
        if stay.distance_to_transit_m is not None
        else None,
        "cancellation": stay.cancellation,
        "amenities": stay.amenities,
    }


def _km(value: Decimal | None) -> str | None:
    return None if value is None else t("ai.stay.km", value=value)


def _compare(a: dict[str, Any], stay_a: Stay, b: dict[str, Any], stay_b: Stay) -> dict[str, Any]:
    diff = stay_b.price_per_night - stay_a.price_per_night
    da, db = stay_a.distance_to_center_km, stay_b.distance_to_center_km
    return {
        "a": a["id"],
        "b": b["id"],
        "cheaper": a["id"] if diff > 0 else (b["id"] if diff < 0 else None),
        "price_per_night_difference_text": money_text(abs(diff), stay_a.currency),
        "closer_to_center": None
        if da is None or db is None or da == db
        else (a["id"] if da < db else b["id"]),
        "distance_difference_text": None if da is None or db is None else _km(abs(db - da)),
    }
