from zoneinfo import ZoneInfo

from tickets_api.reference.airports import MAX_NEARBY_AIRPORTS, default_airport_directory

DIRECTORY = default_airport_directory()


def test_city_code_expands_to_all_airports() -> None:
    assert set(DIRECTORY.airports_for("LON")) >= {"LHR", "LGW", "STN", "LTN"}
    assert DIRECTORY.airports_for("par") == ["BVA", "CDG", "ORY"]


def test_airport_code_resolves_to_itself() -> None:
    assert DIRECTORY.airports_for("LTN") == ["LTN"]
    # WAW — і місто, і аеропорт Шопена: обрано аеропорт, Модлін (WMI) не додаємо.
    assert DIRECTORY.airports_for("waw") == ["WAW"]
    assert DIRECTORY.airports_for("ZZZ") == ["ZZZ"]


def test_timezones() -> None:
    assert DIRECTORY.timezone("WMI") == ZoneInfo("Europe/Warsaw")
    assert DIRECTORY.timezone("LIS") == ZoneInfo("Europe/Lisbon")
    assert DIRECTORY.timezone("ZZZ") is None


def test_snapshot_is_complete() -> None:
    airport = DIRECTORY.get("CDG")
    assert airport is not None
    assert (airport.city, airport.country) == ("PAR", "FR")


def test_accepted_codes_for_requested_place() -> None:
    assert DIRECTORY.accepted("waw") == {"WAW"}  # без Модліна
    assert {"STN", "LON"} <= DIRECTORY.accepted("LON")  # код міста в самій пропозиції


def test_nearby_airports_within_radius() -> None:
    assert DIRECTORY.airports_for("WAW", radius_km=150) == ["WAW", "WMI", "LCJ"]
    assert DIRECTORY.airports_for("KRK", radius_km=100)[:2] == ["KRK", "KTW"]
    # Місто: спершу всі його аеропорти, далі найближчі сусідні, разом не більше 8.
    london = DIRECTORY.airports_for("LON", radius_km=150)
    assert london[:6] == ["LCY", "LGW", "LHR", "LTN", "SEN", "STN"]
    assert len(london) == MAX_NEARBY_AIRPORTS
    assert DIRECTORY.airports_for("ZZZ", radius_km=150) == ["ZZZ"]


def test_nearby_respects_query_radius_when_matching_offers() -> None:
    assert DIRECTORY.accepted("WAW", radius_km=150) == {"WAW", "WMI", "LCJ"}


def test_search_by_name_code_and_without_diacritics() -> None:
    def codes(text: str) -> list[str]:
        return [p.code for p in DIRECTORY.search(text, limit=4)]

    assert codes("вар")[:2] == ["WAW", "WMI"]
    assert codes("Kraków") == codes("krakow") == ["KRK"]
    assert codes("barc")[0] == "BCN"  # популярніша Барселона вище Баркалдіна
    assert codes("пар") == ["PAR", "BVA", "CDG", "ORY"]
    assert codes("lhr")[0] == "LHR"
    assert DIRECTORY.search("в") == []  # закороткий запит


def test_city_entry_only_when_city_code_is_not_an_airport() -> None:
    # WAW — аеропорт Шопена, тож окремого «Варшава — усі аеропорти» не пропонуємо.
    warsaw = DIRECTORY.search("варшава")
    assert [(p.code, p.kind) for p in warsaw[:2]] == [("WAW", "airport"), ("WMI", "airport")]
    assert warsaw[0].city_name == "Варшава"
    assert warsaw[0].country_name == "Польща"
