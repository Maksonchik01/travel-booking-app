"""Оновлює довідник напрямків для Explore (ADR 0045): категорії, сезон моря, регіони країн, фото.

    uv run python scripts/update_destinations.py

Категорії й сезони — кураторські (таблиця нижче): це характеристики міста, а не ціни, тож їх
не вигадує ні модель, ні код під час пошуку. Фото — головне зображення статті англійської
Вікіпедії (MediaWiki API `prop=pageimages`, мініатюра 500px, лише вільні ліцензії) з посиланням
на статтю для атрибуції. Скрипт — єдине
місце, що ходить до Вікіпедії; під час роботи сайту браузер вантажить лише upload.wikimedia.org.
"""

import json
import time
from pathlib import Path
from typing import Any

import httpx

TARGET = Path(__file__).parents[1] / "apps/api/src/tickets_api/reference/destinations.json"
API = "https://en.wikipedia.org/w/api.php"
BATCH = 50
PHOTO_HOST = "https://upload.wikimedia.org/"
THUMB_HOSTS = (PHOTO_HOST, "https://thumb.wikimedia.org/")
PAUSE_S = 1.0
"""Пауза між пакетами: API Вікіпедії відповідає 403 на часті запити."""
USER_AGENT = "SkyPack-reference-updater/1.0 (https://github.com/Maksonchik01/travel-booking-app)"
WIDTH = 500

ALL_YEAR = list(range(1, 13))
MED = [5, 6, 7, 8, 9, 10]
SUMMER = [6, 7, 8, 9]
NORTH = [7, 8]
WINTER_SUN = [10, 11, 12, 1, 2, 3, 4]

# код міста: (стаття Вікіпедії, категорії, місяці моря — лише для "sea")
CITIES: dict[str, tuple[str, list[str], list[int]]] = {
    "PAR": ("Paris", ["city", "romance", "culture", "nightlife"], []),
    "LON": ("London", ["city", "culture", "nightlife"], []),
    "ROM": ("Rome", ["city", "romance", "culture"], []),
    "MIL": ("Milan", ["city", "culture", "nightlife"], []),
    "VCE": ("Venice", ["romance", "culture", "city"], []),
    "FLR": ("Florence", ["culture", "romance", "city"], []),
    "PSA": ("Pisa", ["culture", "city"], []),
    "BLQ": ("Bologna", ["culture", "city"], []),
    "VRN": ("Verona", ["romance", "culture", "city"], []),
    "TRN": ("Turin", ["city", "culture", "mountains"], []),
    "NAP": ("Naples", ["city", "culture", "sea"], MED),
    "BRI": ("Bari", ["sea", "city"], MED),
    "CTA": ("Catania", ["sea", "mountains", "city"], MED),
    "PMO": ("Palermo", ["sea", "culture", "city"], MED),
    "CAG": ("Cagliari", ["sea", "city"], MED),
    "OLB": ("Olbia", ["sea"], MED),
    "RMI": ("Rimini", ["sea", "nightlife"], SUMMER),
    "BCN": ("Barcelona", ["city", "sea", "culture", "nightlife"], MED),
    "MAD": ("Madrid", ["city", "culture", "nightlife"], []),
    "SVQ": ("Seville", ["culture", "romance", "city"], []),
    "GRX": ("Granada", ["culture", "romance", "mountains"], []),
    "VLC": ("Valencia", ["city", "sea", "nightlife"], MED),
    "AGP": ("Málaga", ["sea", "city", "culture"], MED),
    "ALC": ("Alicante", ["sea", "city"], MED),
    "BIO": ("Bilbao", ["city", "culture"], []),
    "PMI": ("Palma de Mallorca", ["sea", "nightlife", "city"], MED),
    "IBZ": ("Ibiza", ["sea", "nightlife"], MED),
    "TCI": ("Tenerife", ["sea", "mountains"], ALL_YEAR),
    "LPA": ("Gran Canaria", ["sea", "nightlife"], ALL_YEAR),
    "ACE": ("Lanzarote", ["sea", "mountains"], ALL_YEAR),
    "FUE": ("Fuerteventura", ["sea"], ALL_YEAR),
    "FNC": ("Madeira", ["mountains", "sea"], [6, 7, 8, 9, 10]),
    "PDL": ("São Miguel Island", ["mountains"], []),
    "LIS": ("Lisbon", ["city", "culture", "nightlife", "romance", "sea"], SUMMER),
    "OPO": ("Porto", ["city", "romance", "culture"], []),
    "FAO": ("Faro, Portugal", ["sea"], MED),
    "NCE": ("Nice", ["sea", "romance", "city"], MED),
    "MRS": ("Marseille", ["sea", "city"], MED),
    "LYS": ("Lyon", ["city", "culture"], []),
    "BOD": ("Bordeaux", ["city", "romance", "culture"], []),
    "NTE": ("Nantes", ["city"], []),
    "TLS": ("Toulouse", ["city", "culture"], []),
    "GVA": ("Geneva", ["city", "mountains"], []),
    "ZRH": ("Zürich", ["city", "mountains"], []),
    "BSL": ("Basel", ["city", "culture"], []),
    "INN": ("Innsbruck", ["mountains"], []),
    "SZG": ("Salzburg", ["culture", "mountains", "romance"], []),
    "VIE": ("Vienna", ["city", "culture", "romance"], []),
    "PRG": ("Prague", ["city", "romance", "culture", "nightlife"], []),
    "BUD": ("Budapest", ["city", "nightlife", "culture", "romance"], []),
    "BTS": ("Bratislava", ["city"], []),
    "BER": ("Berlin", ["city", "nightlife", "culture"], []),
    "MUC": ("Munich", ["city", "culture", "mountains"], []),
    "HAM": ("Hamburg", ["city", "nightlife"], []),
    "FRA": ("Frankfurt", ["city"], []),
    "CGN": ("Cologne", ["city", "culture"], []),
    "AMS": ("Amsterdam", ["city", "nightlife", "romance", "culture"], []),
    "BRU": ("Brussels", ["city", "culture"], []),
    "CPH": ("Copenhagen", ["city", "culture"], []),
    "STO": ("Stockholm", ["city", "culture"], []),
    "GOT": ("Gothenburg", ["city"], []),
    "OSL": ("Oslo", ["city", "mountains"], []),
    "BGO": ("Bergen", ["mountains", "city"], []),
    "TOS": ("Tromsø", ["mountains"], []),
    "HEL": ("Helsinki", ["city"], []),
    "RVN": ("Rovaniemi", ["mountains"], []),
    "REK": ("Reykjavík", ["city", "mountains"], []),
    "DUB": ("Dublin", ["city", "nightlife"], []),
    "EDI": ("Edinburgh", ["city", "culture", "romance"], []),
    "MAN": ("Manchester", ["city", "nightlife"], []),
    "WAW": ("Warsaw", ["city", "culture"], []),
    "KRK": ("Kraków", ["city", "culture", "nightlife"], []),
    "GDN": ("Gdańsk", ["city", "sea"], NORTH),
    "WRO": ("Wrocław", ["city", "culture"], []),
    "RIX": ("Riga", ["city", "nightlife"], []),
    "TLL": ("Tallinn", ["city", "culture"], []),
    "VNO": ("Vilnius", ["city", "culture"], []),
    "LJU": ("Ljubljana", ["city", "mountains", "romance"], []),
    "ZAG": ("Zagreb", ["city"], []),
    "SPU": ("Split, Croatia", ["sea", "nightlife", "culture"], SUMMER),
    "DBV": ("Dubrovnik", ["sea", "romance", "culture"], MED),
    "ZAD": ("Zadar", ["sea"], SUMMER),
    "PUY": ("Pula", ["sea", "culture"], SUMMER),
    "TIV": ("Tivat", ["sea", "mountains"], SUMMER),
    "BEG": ("Belgrade", ["city", "nightlife"], []),
    "SOF": ("Sofia", ["city", "mountains"], []),
    "BUH": ("Bucharest", ["city", "nightlife"], []),
    "TIA": ("Tirana", ["city"], []),
    "ATH": ("Athens", ["city", "culture", "sea"], MED),
    "SKG": ("Thessaloniki", ["city", "sea", "nightlife"], SUMMER),
    "HER": ("Heraklion", ["sea", "culture"], MED),
    "CHQ": ("Chania", ["sea", "romance"], MED),
    "RHO": ("Rhodes", ["sea", "culture"], MED),
    "JTR": ("Santorini", ["sea", "romance"], MED),
    "JMK": ("Mykonos", ["sea", "nightlife"], SUMMER),
    "CFU": ("Corfu", ["sea", "romance"], SUMMER),
    "ZTH": ("Zakynthos", ["sea"], SUMMER),
    "KGS": ("Kos", ["sea"], SUMMER),
    "LCA": ("Larnaca", ["sea"], [4, 5, 6, 7, 8, 9, 10, 11]),
    "PFO": ("Paphos", ["sea", "culture"], [4, 5, 6, 7, 8, 9, 10, 11]),
    "MLA": ("Malta", ["sea", "culture", "nightlife"], MED),
    "IST": ("Istanbul", ["city", "culture", "nightlife"], []),
    "AYT": ("Antalya", ["sea"], MED),
    "DLM": ("Dalaman", ["sea", "mountains"], MED),
    "BJV": ("Bodrum", ["sea", "nightlife"], MED),
    "TBS": ("Tbilisi", ["city", "culture", "mountains", "nightlife"], []),
    "BUS": ("Batumi", ["sea", "nightlife"], SUMMER),
    "EVN": ("Yerevan", ["city", "culture"], []),
    "TLV": ("Tel Aviv", ["sea", "nightlife", "city"], [5, 6, 7, 8, 9, 10, 11]),
    "DXB": ("Dubai", ["city", "sea", "nightlife"], WINTER_SUN),
    "AUH": ("Abu Dhabi", ["city", "sea"], WINTER_SUN),
    "DOH": ("Doha", ["city"], []),
    "RAK": ("Marrakesh", ["culture", "romance"], []),
    "AGA": ("Agadir", ["sea"], ALL_YEAR),
    "TNG": ("Tangier", ["culture", "city"], []),
    "RBA": ("Rabat", ["culture", "city"], []),
    "TUN": ("Tunis", ["culture", "city"], []),
    "DJE": ("Djerba", ["sea"], MED),
    "CAI": ("Cairo", ["culture", "city"], []),
    "HRG": ("Hurghada", ["sea"], ALL_YEAR),
    "SSH": ("Sharm El Sheikh", ["sea"], ALL_YEAR),
    "NYC": ("New York City", ["city", "culture", "nightlife"], []),
    "BKK": ("Bangkok", ["city", "nightlife", "culture"], []),
    "HKT": ("Phuket province", ["sea", "nightlife"], [11, 12, 1, 2, 3, 4]),
    "DPS": ("Bali", ["sea", "romance", "mountains"], [4, 5, 6, 7, 8, 9, 10]),
    "SIN": ("Singapore", ["city"], []),
    "TYO": ("Tokyo", ["city", "culture", "nightlife"], []),
    "MLE": ("Maldives", ["sea", "romance"], ALL_YEAR),
}

# Стаття для фото, коли головне зображення статті міста — прапор, карта чи колаж.
PHOTO_TITLES = {
    "IBZ": "Ibiza (city)",
    "DOH": "Doha Corniche",
    "FNC": "Funchal",
    "JTR": "Oia, Greece",
    "JMK": "Mykonos windmills",
    "MLA": "Valletta",
    "DPS": "Tanah Lot",
    "SIN": "Marina Bay Sands",
    "MLE": "Malé",
    "BIO": "Guggenheim Museum Bilbao",
}
NOT_PHOTO = (".svg", "flag_of", "locator", "dimos_")
"""Прапори, карти розташування й мапи громад — не фото напрямку."""

# Регіони пошуку «напрямок — регіон»: країни ISO 3166-1.
REGIONS: dict[str, list[str]] = {
    "europe": [
        "AD",
        "AL",
        "AT",
        "BA",
        "BE",
        "BG",
        "BY",
        "CH",
        "CY",
        "CZ",
        "DE",
        "DK",
        "EE",
        "ES",
        "FI",
        "FO",
        "FR",
        "GB",
        "GI",
        "GR",
        "HR",
        "HU",
        "IE",
        "IM",
        "IS",
        "IT",
        "LI",
        "LT",
        "LU",
        "LV",
        "MC",
        "MD",
        "ME",
        "MK",
        "MT",
        "NL",
        "NO",
        "PL",
        "PT",
        "RO",
        "RS",
        "SE",
        "SI",
        "SK",
        "SM",
        "UA",
        "VA",
        "XK",
        "GE",
        "AM",
        "AZ",
        "TR",
    ],
    "middle_east": [
        "AE",
        "BH",
        "IL",
        "IQ",
        "IR",
        "JO",
        "KW",
        "LB",
        "OM",
        "PS",
        "QA",
        "SA",
        "SY",
        "YE",
    ],
    "africa": [
        "DZ",
        "AO",
        "BJ",
        "BW",
        "BF",
        "BI",
        "CM",
        "CV",
        "CF",
        "TD",
        "KM",
        "CG",
        "CD",
        "CI",
        "DJ",
        "EG",
        "GQ",
        "ER",
        "ET",
        "GA",
        "GM",
        "GH",
        "GN",
        "GW",
        "KE",
        "LS",
        "LR",
        "LY",
        "MG",
        "MW",
        "ML",
        "MR",
        "MU",
        "YT",
        "MA",
        "MZ",
        "NA",
        "NE",
        "NG",
        "RE",
        "RW",
        "SH",
        "ST",
        "SN",
        "SC",
        "SL",
        "SO",
        "ZA",
        "SS",
        "SD",
        "SZ",
        "TZ",
        "TG",
        "TN",
        "UG",
        "EH",
        "ZM",
        "ZW",
    ],
    "asia": [
        "AF",
        "BD",
        "BT",
        "BN",
        "KH",
        "CN",
        "HK",
        "IN",
        "ID",
        "JP",
        "KZ",
        "KG",
        "LA",
        "MO",
        "MY",
        "MV",
        "MN",
        "MM",
        "NP",
        "KP",
        "PK",
        "PH",
        "SG",
        "KR",
        "LK",
        "TW",
        "TJ",
        "TH",
        "TL",
        "TM",
        "UZ",
        "VN",
    ],
    "north_america": [
        "US",
        "CA",
        "MX",
        "BM",
        "GL",
        "PM",
        "AG",
        "BS",
        "BB",
        "BZ",
        "CR",
        "CU",
        "DM",
        "DO",
        "SV",
        "GD",
        "GT",
        "HT",
        "HN",
        "JM",
        "KN",
        "LC",
        "VC",
        "NI",
        "PA",
        "TT",
        "AW",
        "CW",
        "SX",
        "BQ",
        "KY",
        "TC",
        "VG",
        "VI",
        "PR",
        "AI",
        "MS",
        "GP",
        "MQ",
        "BL",
        "MF",
    ],
    "south_america": [
        "AR",
        "BO",
        "BR",
        "CL",
        "CO",
        "EC",
        "FK",
        "GF",
        "GY",
        "PY",
        "PE",
        "SR",
        "UY",
        "VE",
    ],
    "oceania": [
        "AU",
        "NZ",
        "FJ",
        "PG",
        "SB",
        "VU",
        "NC",
        "PF",
        "WS",
        "TO",
        "KI",
        "TV",
        "NR",
        "PW",
        "FM",
        "MH",
        "CK",
        "NU",
        "GU",
        "MP",
        "AS",
    ],
}


def photos(client: httpx.Client, titles: list[str]) -> dict[str, dict[str, str]]:
    """Стаття → фото пакетами по 50 (MediaWiki `prop=pageimages`, лише вільні ліцензії)."""
    found: dict[str, dict[str, str]] = {}
    for start in range(0, len(titles), BATCH):
        batch = titles[start : start + BATCH]
        data: dict[str, Any] = (
            client.get(
                API,
                params={
                    "action": "query",
                    "format": "json",
                    "formatversion": "2",
                    "redirects": "1",
                    "prop": "pageimages|info",
                    "piprop": "thumbnail",
                    "pithumbsize": str(WIDTH),
                    "pilicense": "free",
                    "inprop": "url",
                    "titles": "|".join(batch),
                },
            )
            .raise_for_status()
            .json()
        )
        query = data.get("query") or {}
        # Нормалізація й перенаправлення: запитана назва → підсумкова стаття.
        alias = {t: t for t in batch}
        for step in ("normalized", "redirects"):
            for item in query.get(step) or []:
                for asked, final in alias.items():
                    if final == item["from"]:
                        alias[asked] = item["to"]
        pages = {page["title"]: page for page in query.get("pages") or []}
        for asked, final in alias.items():
            page = pages.get(final) or {}
            thumb = (page.get("thumbnail") or {}).get("source")
            if (
                isinstance(thumb, str)
                and thumb.startswith(THUMB_HOSTS)
                and not any(word in thumb.lower() for word in NOT_PHOTO)
                and page.get("fullurl")
            ):
                # Один хост для браузера (і для «Конфіденційності»), без utm-параметрів.
                path = thumb.split("?", 1)[0].split("/", 3)[3]
                found[asked] = {"url": PHOTO_HOST + path, "page": page["fullurl"]}
            else:
                print(f"  {asked}: без фото")
        time.sleep(PAUSE_S)
    return found


def main() -> None:
    with httpx.Client(timeout=30, headers={"User-Agent": USER_AGENT}) as client:
        titles = {code: PHOTO_TITLES.get(code, title) for code, (title, _, _) in CITIES.items()}
        found = photos(client, list(titles.values()))
    cities = {
        code: {
            "categories": tags,
            "sea_months": sea if "sea" in tags else [],
            "photo": found.get(titles[code]),
        }
        for code, (_, tags, sea) in CITIES.items()
    }
    TARGET.write_text(
        json.dumps({"regions": REGIONS, "cities": cities}, ensure_ascii=False, indent=1) + "\n"
    )
    print(f"{len(cities)} напрямків, з фото: {sum(1 for c in cities.values() if c['photo'])}")


if __name__ == "__main__":
    main()
