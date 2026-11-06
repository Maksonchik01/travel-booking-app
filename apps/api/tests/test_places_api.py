from httpx import AsyncClient


async def test_places_autocomplete(client: AsyncClient) -> None:
    response = await client.get("/places", params={"q": "лон", "limit": 3})

    assert response.status_code == 200
    first, *rest = response.json()
    assert first == {
        "code": "LON",
        "kind": "city",
        "name": "Лондон",
        "city_name": "Лондон",
        "country_name": "Велика Британія",
        "airports": ["LCY", "LGW", "LHR", "LTN", "SEN", "STN"],
    }
    assert [p["kind"] for p in rest] == ["airport", "airport"]


async def test_places_in_english(client: AsyncClient) -> None:
    response = await client.get("/places", params={"q": "WAW", "lang": "en"})

    [waw, *_] = response.json()
    assert (waw["code"], waw["city_name"], waw["country_name"]) == ("WAW", "Warsaw", "Poland")


async def test_places_validates_input(client: AsyncClient) -> None:
    assert (await client.get("/places", params={"q": ""})).status_code == 422
    assert (await client.get("/places", params={"q": "x", "limit": 50})).status_code == 422


async def test_city_only_suggestions_for_stays(client: AsyncClient) -> None:
    # Варшава має код міста, що збігається з аеропортом (WAW), і ще Модлін (WMI).
    places = (await client.get("/places", params={"q": "варшава", "kind": "city"})).json()

    assert [(p["code"], p["kind"], p["name"]) for p in places[:1]] == [("WAW", "city", "Варшава")]
    assert len([p for p in places if p["name"] == "Варшава"]) == 1
    assert {"WAW", "WMI"} <= set(places[0]["airports"])
    # Назва аеропорту теж веде до міста; кожне місто — один раз.
    by_airport = (await client.get("/places", params={"q": "Модлін", "kind": "city"})).json()
    assert by_airport[0]["code"] == "WAW"
    london = (await client.get("/places", params={"q": "LON", "kind": "city"})).json()
    assert [p["code"] for p in london].count("LON") == 1
