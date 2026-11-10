"""Етап 7 (ADR 0051): перенесення збереженого гостем без дублікатів, обране «напрямок», чекліст.

Наскрізно через HTTP API проти Postgres і Redis (TEST_DATABASE_URL / TEST_REDIS_URL)."""

from datetime import UTC, date, datetime

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from test_accounts import saved_trip
from test_isolation import json, register
from tickets_api.domain.favorites import FavoriteDestination
from tickets_api.domain.saved_trips import ChecklistItem

DESTINATION = {
    "code": "DUB",
    "city": "Дублін",
    "country": "IE",
    "depart": "2026-12-14",
    "back": "2026-12-16",
    "nights": 2,
    "price": 144,
    "currency": "EUR",
    "price_at": "2026-11-11T10:00:00Z",
    "photo_url": "https://upload.wikimedia.org/x.jpg",
    "params": "from=AMS&depart=2026-12-01&until=2026-12-31",
}


@pytest.mark.integration
async def test_guest_saves_move_once_without_duplicates(live_client: AsyncClient) -> None:
    me = await register(live_client, "guest")
    trip = json(saved_trip("Лісабон"))
    trip["checklist"] = [{"id": "c1", "key": "documents", "done": True}]
    searches = [
        {"kind": "explore", "params": "from=AMS&depart=2026-12-01&until=2026-12-31", "title": "E"},
        {"kind": "flights", "params": "from=WAW&to=LIS", "title": "F"},
    ]
    favorite = {"kind": "destination", "destination": DESTINATION}

    # Двічі те саме (інший браузер, повтор) — у профілі по одному.
    for _ in range(2):
        trips = await live_client.post(
            "/account/trips/import", json={"items": [trip, trip]}, headers=me
        )
        assert trips.status_code == 200, trips.text
        saved = await live_client.post(
            "/account/saved/import", json={"items": searches}, headers=me
        )
        assert saved.status_code == 200, saved.text
        favorites = await live_client.post(
            "/account/favorites/import", json={"items": [favorite]}, headers=me
        )
        assert favorites.status_code == 200, favorites.text

    trips_now = (await live_client.get("/account/trips", headers=me)).json()
    assert len(trips_now) == 1
    assert trips_now[0]["checklist"] == [
        {"id": "c1", "key": "documents", "text": None, "done": True}
    ]
    kinds = {
        s["kind"]
        for s in (await live_client.get("/account/searches?saved=true", headers=me)).json()
    }
    assert kinds == {"explore", "flights"}
    favs = (await live_client.get("/account/favorites", headers=me)).json()
    assert [(f["kind"], f["destination"]["code"]) for f in favs] == [("destination", "DUB")]


@pytest.mark.integration
async def test_trip_checklist_add_edit_toggle_delete(live_client: AsyncClient) -> None:
    me = await register(live_client, "check")
    other = await register(live_client, "check_other")
    trip = (
        await live_client.post("/account/trips", json=json(saved_trip("Рим")), headers=me)
    ).json()
    assert trip["checklist"] == []
    url = f"/account/trips/{trip['id']}/checklist"

    items = [
        {"id": "a", "key": "documents", "done": False},
        {"id": "b", "key": "baggage", "done": True},
        {"id": "c", "text": "Купити адаптер", "done": False},
    ]
    saved = await live_client.put(url, json={"items": items}, headers=me)
    assert saved.status_code == 200, saved.text
    assert [i["id"] for i in saved.json()["checklist"]] == ["a", "b", "c"]

    # Редагування, виконання й видалення — новий список цілком.
    items = [
        {"id": "a", "key": "documents", "done": True},
        {"id": "c", "text": "Купити адаптер на UK", "done": False},
    ]
    saved = await live_client.put(url, json={"items": items}, headers=me)
    assert [(i["id"], i["done"], i["text"]) for i in saved.json()["checklist"]] == [
        ("a", True, None),
        ("c", False, "Купити адаптер на UK"),
    ]
    # Чужий чекліст не змінити.
    assert (await live_client.put(url, json={"items": []}, headers=other)).status_code == 404


def test_checklist_and_destination_validation() -> None:
    with pytest.raises(ValidationError):
        ChecklistItem(id="x")  # ні ключа, ні тексту
    with pytest.raises(ValidationError):
        ChecklistItem(id="x", key="documents", text="і те, й те")
    with pytest.raises(ValidationError):
        FavoriteDestination.model_validate({**DESTINATION, "photo_url": "https://evil.test/x.jpg"})
    dest = FavoriteDestination.model_validate(DESTINATION)
    assert dest.item_key == "dest|DUB|2026-12-14|2026-12-16"
    assert dest.price_at == datetime(2026, 11, 11, 10, tzinfo=UTC)
    assert dest.depart == date(2026, 12, 14)
