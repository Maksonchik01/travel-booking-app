"""Профіль і особисті налаштування пошуку (модуль 10b). Без I/O.

Налаштування пошуку — лише ЗНАЧЕННЯ ЗА ЗАМОВЧУВАННЯМ для нового пошуку: веб підставляє їх
у форму, а конкретний пошук може їх змінити, не чіпаючи збережене в профілі.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints

from tickets_api.domain.flights import BaggageNeed, Cabin, DeparturePeriod, _StrictInput
from tickets_api.domain.locale import UiLocale
from tickets_api.domain.stays import Amenity, StayKind, StayProfile


def _upper(value: object) -> object:
    return value.strip().upper() if isinstance(value, str) else value


ProfileCurrency = Literal["EUR", "USD", "GBP", "PLN"]
"""Валюти, які вміє пошук (ADR 0015)."""
PlaceCode = Annotated[str, BeforeValidator(_upper), StringConstraints(pattern=r"^[A-Z]{3}$")]
"""Код аеропорту чи міста IATA; чи він існує — перевіряє сервіс за довідником."""
CountryCode = Annotated[str, BeforeValidator(_upper), StringConstraints(pattern=r"^[A-Z]{2}$")]
AirlineCode = Annotated[str, BeforeValidator(_upper), StringConstraints(pattern=r"^[A-Z0-9]{2}$")]
MAX_FAVORITE_AIRPORTS = 5


def _unique[T](values: list[T]) -> list[T]:
    return list(dict.fromkeys(values))


class FlightPrefs(_StrictInput):
    cabin: Cabin | None = None
    baggage: BaggageNeed | None = None
    max_stops: int | None = Field(default=None, ge=0, le=2)
    airlines: Annotated[list[AirlineCode], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=10
    )
    """Бажані авіакомпанії (фільтр `al`)."""
    profile: Literal["budget", "balanced", "time_is_money"] | None = None
    """Пріоритет скорингу: ціна / баланс / швидкість."""
    departure_periods: Annotated[list[DeparturePeriod], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=4
    )


class StayPrefs(_StrictInput):
    kinds: Annotated[list[StayKind], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=5
    )
    min_rating: Literal[7, 8, 9] | None = None
    max_distance_km: Literal[1, 2, 3, 5, 10] | None = None
    amenities: Annotated[list[Amenity], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=20
    )
    free_cancellation: bool = False
    profile: StayProfile | None = None


class SearchPrefs(_StrictInput):
    flights: FlightPrefs = Field(default_factory=FlightPrefs)
    stays: StayPrefs = Field(default_factory=StayPrefs)


class PreferencesBody(_StrictInput):
    """Налаштування профілю: форма надсилає всі поля (None — «не задано»)."""

    locale: UiLocale | None = None
    currency: ProfileCurrency | None = None
    country: CountryCode | None = None
    """Країна проживання (ISO 3166-1 alpha-2)."""
    home_airport: PlaceCode | None = None
    favorite_airports: Annotated[list[PlaceCode], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=MAX_FAVORITE_AIRPORTS
    )


class LocaleBody(_StrictInput):
    """Перемикач мови в шапці: лише мова, без решти профілю."""

    locale: UiLocale
