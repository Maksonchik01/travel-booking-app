"""Модуль 21.5: ізоляція даних користувачів — наскрізно через HTTP API проти Postgres і Redis.

Користувач B не бачить і не змінює нічого з даних A: обране, збережені пошуки й історію,
збережені поїздки (і публічне посилання), розмови, сесії. Без сесії — 401 скрізь.
"""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from test_accounts import favorite, saved_trip

pytestmark = pytest.mark.integration


PRIVATE = (
    "/account",
    "/account/favorites",
    "/account/searches?saved=true",
    "/account/trips",
    "/account/chats",
    "/account/sessions",
    "/account/alerts",
)


async def register(client: AsyncClient, name: str) -> dict[str, str]:
    response = await client.post(
        "/auth/register",
        json={"username": f"iso_{name}_{uuid.uuid4().hex[:8]}", "password": "password123"},
    )
    assert response.status_code in (200, 201), response.text
    return {"authorization": f"Bearer {response.json()['token']}"}


def json(model: Any) -> Any:
    return model.model_dump(mode="json")


async def test_one_user_never_sees_or_changes_anothers_data(live_client: AsyncClient) -> None:
    a = await register(live_client, "a")
    b = await register(live_client, "b")
    try:
        # A: обране, збережений пошук, поїздка з публічним посиланням, розмова.
        assert (
            await live_client.post("/account/favorites", json=json(favorite()), headers=a)
        ).status_code in (200, 201)
        saved = await live_client.post(
            "/account/saved",
            json={"kind": "flights", "params": "from=WAW&to=LIS", "title": "A"},
            headers=a,
        )
        assert saved.status_code in (200, 201)
        trip = (
            await live_client.post("/account/trips", json=json(saved_trip("A")), headers=a)
        ).json()
        await live_client.post(f"/account/trips/{trip['id']}/share", headers=a)
        await live_client.put("/account/chats/sync", json={"enabled": True}, headers=a)
        chat = {
            "title": "A",
            "mode": "trip",
            "created_at": 1,
            "updated_at": 2,
            "turns": [{"role": "user", "text": "Привіт"}],
        }
        await live_client.put("/account/chats/conv-a", json=chat, headers=a)

        # B бачить порожнечу.
        assert (await live_client.get("/account/favorites", headers=b)).json() == []
        assert (await live_client.get("/account/searches?saved=true", headers=b)).json() == []
        assert (await live_client.get("/account/trips", headers=b)).json() == []
        b_chats = (await live_client.get("/account/chats", headers=b)).json()
        assert b_chats.get("conversations", []) == []
        sessions_b = (await live_client.get("/account/sessions", headers=b)).json()
        assert all(s.get("current") for s in sessions_b)  # лише власна сесія

        # B не змінює й не видаляє чужого: 404 чи «нічого не сталося».
        trip_id = trip["id"]
        assert (
            await live_client.patch(
                f"/account/trips/{trip_id}", json={"title": "Hacked"}, headers=b
            )
        ).status_code == 404
        assert (
            await live_client.post(f"/account/trips/{trip_id}/share", headers=b)
        ).status_code == 404
        await live_client.delete(f"/account/trips/{trip_id}", headers=b)
        await live_client.delete(f"/account/searches/{saved.json()['id']}", headers=b)
        await live_client.delete(
            "/account/favorites", params={"key": "stay:mock:mock-lis-3"}, headers=b
        )
        a_sessions = (await live_client.get("/account/sessions", headers=a)).json()
        await live_client.delete(f"/account/sessions/{a_sessions[0]['id']}", headers=b)

        # У A все на місці, сесія жива, назва не змінена.
        trips_a = (await live_client.get("/account/trips", headers=a)).json()
        assert [t["title"] for t in trips_a] == ["A"]
        assert len((await live_client.get("/account/searches?saved=true", headers=a)).json()) == 1
        assert len((await live_client.get("/account/favorites", headers=a)).json()) == 1
        assert (await live_client.get("/account", headers=a)).status_code == 200

        # Публічне посилання A не віддає нічого про власника.
        shared = await live_client.get(f"/shared/trips/{trips_a[0]['share_token']}")
        assert shared.status_code == 200
        assert "iso_a" not in shared.text
    finally:
        for headers in (a, b):
            await live_client.post(
                "/account/delete", json={"confirm": "password123"}, headers=headers
            )


@pytest.mark.parametrize("path", PRIVATE)
async def test_private_endpoints_need_a_session(live_client: AsyncClient, path: str) -> None:
    assert (await live_client.get(path)).status_code == 401
    bad = {"authorization": "Bearer not-a-real-token"}
    assert (await live_client.get(path, headers=bad)).status_code == 401
