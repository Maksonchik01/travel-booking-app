from httpx import AsyncClient

BODY = {"origin": "waw", "destination": "lis", "departure_date": "2026-11-10"}


async def test_search_returns_offers_even_when_history_db_is_down(client: AsyncClient) -> None:
    # У фікстурі `client` БД недоступна: запис історії падає, але пошук — ні.
    response = await client.post("/flights/search", json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert body["providers"] == [{"provider": "mock", "status": "ok", "error": None, "results": 4}]
    offer = body["offers"][0]
    assert offer["currency"] == "EUR"
    assert offer["source"] == "mock"
    assert isinstance(offer["price"], float)
    assert {"collected_at", "found_at", "stops", "total_duration_min"} <= offer.keys()


async def test_search_validates_input(client: AsyncClient) -> None:
    response = await client.post("/flights/search", json={**BODY, "destination": "WAW"})

    assert response.status_code == 422


async def test_calendar(client: AsyncClient) -> None:
    response = await client.get(
        "/flights/calendar", params={"origin": "WAW", "destination": "LIS", "month": "2026-11"}
    )

    assert response.status_code == 200
    days = response.json()["days"]
    assert days[0]["date"] == "2026-11-01"
    assert all(d["currency"] == "EUR" for d in days)


async def test_calendar_rejects_bad_month(client: AsyncClient) -> None:
    response = await client.get(
        "/flights/calendar", params={"origin": "WAW", "destination": "LIS", "month": "2026-13"}
    )

    assert response.status_code == 422


async def test_search_includes_scoring_for_requested_profile(client: AsyncClient) -> None:
    response = await client.post("/flights/search", json={**BODY, "profile": "budget"})

    scoring = response.json()["scoring"]
    assert scoring["profile"] == "budget"
    assert scoring["currency"] == "EUR"
    offer_keys = {f"{o['source']}:{o['id']}" for o in response.json()["offers"]}
    assert {s["offer_key"] for s in scoring["scores"]} == offer_keys
    labels = [p["label"] for p in scoring["picks"]] + [
        label for p in scoring["picks"] for label in p["also"]
    ]
    assert sorted(labels) == ["balanced", "cheapest", "fastest"]
    breakdown = scoring["scores"][0]["breakdown"]
    assert set(breakdown) == {
        "price",
        "baggage_extra",
        "preference_penalty",
        "preference_misses",
        "time_penalty",
        "stop_penalty",
        "risk_penalties",
        "risk_total",
        "total",
    }


async def test_unknown_profile_is_rejected(client: AsyncClient) -> None:
    response = await client.post("/flights/search", json={**BODY, "profile": "yolo"})

    assert response.status_code == 422
