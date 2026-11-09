"""Уточнення поточного пошуку в розмові (модуль 9a): модель передає лише ЗМІНИ, код накладає
їх на поточний запит. «Лише прямі» → пересадки, «після 18:00» → час вильоту, «збільш бюджет
до 600» → лише бюджет; решта параметрів не губиться й не вигадується.

Відносні зміни («на 100 € більше») рахує код від поточного значення; якщо його немає —
помилка, і модель питає абсолютне значення.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tickets_api.domain.flights import BaggageNeed, Cabin, FlightQuery, HourRange
from tickets_api.domain.stays import Amenity, StayKind, StayQuery
from tickets_api.domain.trips import TripQuery

FlightClear = Literal["stops", "times", "price", "airlines"]
StayClear = Literal["price", "rating", "distance", "conditions", "kinds"]


class RefineError(ValueError):
    """Зміну не застосувати (немає від чого рахувати тощо) — текст іде моделі."""


class FlightRefinement(BaseModel):
    model_config = ConfigDict(extra="ignore")

    origin: str | None = None
    destination: str | None = None
    departure_date: date | None = None
    return_date: date | None = None
    one_way: bool | None = None
    flex_days: int | None = Field(default=None, ge=0, le=7)
    adults: int | None = Field(default=None, ge=1, le=9)
    children: int | None = Field(default=None, ge=0, le=8)
    direct_only: bool | None = None
    max_stops: int | None = Field(default=None, ge=0, le=3)
    departure_after: int | None = Field(default=None, ge=0, le=23)
    departure_before: int | None = Field(default=None, ge=1, le=24)
    return_departure_after: int | None = Field(default=None, ge=0, le=23)
    return_departure_before: int | None = Field(default=None, ge=1, le=24)
    max_price: int | None = Field(default=None, ge=1, le=100_000)
    """Максимум за квитки одного пасажира, у валюті пошуку."""
    max_price_change: int | None = Field(default=None, ge=-100_000, le=100_000)
    """Змінити поточний максимум на стільки (+/−)."""
    max_total_price: int | None = Field(default=None, ge=1, le=1_000_000)
    airlines: list[str] | None = Field(default=None, max_length=20)
    exclude_airlines: list[str] | None = Field(default=None, max_length=20)
    baggage: BaggageNeed | None = None
    cabin: Cabin | None = None
    profile: Literal["budget", "balanced", "time_is_money"] | None = None
    clear: list[FlightClear] = Field(default_factory=list)


def _hours(after: int | None, before: int | None, current: HourRange | None) -> HourRange | None:
    if after is None and before is None:
        return current
    start = after if after is not None else (current.start if current else 0)
    end = before if before is not None else (current.end if current else 24)
    return HourRange(start=start, end=end)


def refine_flights(current: FlightQuery, change: FlightRefinement) -> FlightQuery:
    """Поточний пошук + зміни. Коди аеропортів уже перевірені викликачем."""
    f = current.filters
    filters: dict[str, object] = f.model_dump()
    if "stops" in change.clear:
        filters["max_stops"] = None
    if "times" in change.clear:
        for key in ("departure_hours", "return_departure_hours", "arrival_hours"):
            filters[key] = None
        for key in ("departure_periods", "return_departure_periods", "arrival_periods"):
            filters[key] = []
    if "price" in change.clear:
        filters["max_price"] = filters["max_total_price"] = None
    if "airlines" in change.clear:
        filters["airlines"] = filters["excluded_airlines"] = []
    if change.max_stops is not None:
        filters["max_stops"] = change.max_stops
    departure = _hours(change.departure_after, change.departure_before, f.departure_hours)
    if departure is not f.departure_hours:
        filters["departure_hours"] = departure.model_dump() if departure else None
        filters["departure_periods"] = []
    back = _hours(
        change.return_departure_after, change.return_departure_before, f.return_departure_hours
    )
    if back is not f.return_departure_hours:
        filters["return_departure_hours"] = back.model_dump() if back else None
        filters["return_departure_periods"] = []
    if change.max_price is not None:
        filters["max_price"] = change.max_price
    if change.max_price_change is not None:
        if f.max_price is None:
            raise RefineError(
                "there is no current max price to change; ask the user for the amount"
            )
        filters["max_price"] = max(1, f.max_price + change.max_price_change)
    if change.max_total_price is not None:
        filters["max_total_price"] = change.max_total_price
    if change.airlines is not None:
        filters["airlines"] = [a.strip().upper() for a in change.airlines]
    if change.exclude_airlines is not None:
        filters["excluded_airlines"] = [a.strip().upper() for a in change.exclude_airlines]

    update: dict[str, object] = {"filters": filters}
    for key in ("origin", "destination", "departure_date", "flex_days", "cabin", "baggage"):
        value = getattr(change, key)
        if value is not None:
            update[key] = value
    if change.profile is not None:
        update["profile"] = change.profile
    if change.return_date is not None:
        update["return_date"] = change.return_date
    if change.one_way:
        update["return_date"] = None
    if change.direct_only is not None:
        update["direct_only"] = change.direct_only
        if change.direct_only:
            filters["max_stops"] = None  # «лише прямі» — сильніша умова
    if change.adults is not None or change.children is not None:
        passengers = current.passengers.model_dump()
        if change.adults is not None:
            passengers["adults"] = change.adults
        if change.children is not None:
            passengers["children"] = change.children
        update["passengers"] = passengers
    if update.get("origin") != current.origin and "origin" in update:
        update["origin_radius_km"] = 0
    if update.get("destination") != current.destination and "destination" in update:
        update["destination_radius_km"] = 0
    # Через валідацію: зміни мають дати коректний запит, інакше — помилка моделі.
    return FlightQuery.model_validate({**current.model_dump(), **update})


class StayRefinement(BaseModel):
    model_config = ConfigDict(extra="ignore")

    city: str | None = None
    check_in: date | None = None
    check_out: date | None = None
    adults: int | None = Field(default=None, ge=1, le=9)
    children: int | None = Field(default=None, ge=0, le=8)
    max_price_per_night: int | None = Field(default=None, ge=1, le=100_000)
    max_price_change: int | None = Field(default=None, ge=-100_000, le=100_000)
    min_rating: float | None = Field(default=None, ge=0, le=10)
    max_distance_km: float | None = Field(default=None, gt=0, le=100)
    free_cancellation: bool | None = None
    breakfast_included: bool | None = None
    kinds: list[StayKind] | None = None
    amenities: list[Amenity] | None = None
    priority: Literal["budget", "balanced", "center"] | None = None
    clear: list[StayClear] = Field(default_factory=list)


def refine_stays(current: StayQuery, change: StayRefinement) -> StayQuery:
    f = current.filters
    filters: dict[str, object] = f.model_dump()
    if "price" in change.clear:
        filters["max_price_per_night"] = filters["max_total_price"] = None
    if "rating" in change.clear:
        filters["min_rating"] = None
    if "distance" in change.clear:
        filters["max_distance_center_km"] = None
    if "conditions" in change.clear:
        filters["free_cancellation"] = filters["breakfast_included"] = False
    if "kinds" in change.clear:
        filters["kinds"] = []
    if change.max_price_per_night is not None:
        filters["max_price_per_night"] = change.max_price_per_night
    if change.max_price_change is not None:
        if f.max_price_per_night is None:
            raise RefineError(
                "there is no current price limit to change; ask the user for the amount"
            )
        filters["max_price_per_night"] = max(1, f.max_price_per_night + change.max_price_change)
    if change.min_rating is not None:
        filters["min_rating"] = change.min_rating
    if change.max_distance_km is not None:
        filters["max_distance_center_km"] = change.max_distance_km
    if change.free_cancellation is not None:
        filters["free_cancellation"] = change.free_cancellation
    if change.breakfast_included is not None:
        filters["breakfast_included"] = change.breakfast_included
    if change.kinds is not None:
        filters["kinds"] = change.kinds
    if change.amenities is not None:
        filters["amenities"] = change.amenities
    update: dict[str, object] = {"filters": filters}
    for key in ("city", "check_in", "check_out"):
        value = getattr(change, key)
        if value is not None:
            update[key] = value
    if change.priority is not None:
        update["profile"] = change.priority
    if change.adults is not None or change.children is not None:
        guests = current.guests.model_dump()
        if change.adults is not None:
            guests["adults"] = change.adults
        if change.children is not None:
            guests["children"] = change.children
            guests["children_ages"] = []
        update["guests"] = guests
    return StayQuery.model_validate({**current.model_dump(), **update})


FlightPreference = Literal["keep", "cheaper", "faster", "fewer_stops"]
StayPreference = Literal["keep", "cheaper", "closer_to_center", "better_rating"]


class TripChange(BaseModel):
    """Зміна готової поїздки: що лишити, що замінити і як, які умови змінити."""

    model_config = ConfigDict(extra="ignore")

    flight: FlightPreference | None = None
    stay: StayPreference | None = None
    budget_total: int | None = Field(default=None, ge=1, le=1_000_000)
    budget_change: int | None = Field(default=None, ge=-1_000_000, le=1_000_000)
    departure_date: date | None = None
    return_date: date | None = None
    adults: int | None = Field(default=None, ge=1, le=9)
    children: int | None = Field(default=None, ge=0, le=8)
    direct_only: bool | None = None
    stay_min_rating: float | None = Field(default=None, ge=0, le=10)
    stay_max_distance_km: float | None = Field(default=None, gt=0, le=100)
    stay_free_cancellation: bool | None = None
    stay_breakfast: bool | None = None


def refine_trip(current: TripQuery, change: TripChange) -> TripQuery:
    """Умови поїздки (без вибору рейсу й житла — його робить планувальник за варіантами)."""
    update: dict[str, object] = {}
    if change.budget_total is not None:
        update["budget_total"] = change.budget_total
    if change.budget_change is not None:
        if current.budget_total is None:
            raise RefineError("the trip has no budget yet; ask the user for the total budget")
        update["budget_total"] = max(1, current.budget_total + change.budget_change)
    for key in ("departure_date", "adults", "children", "direct_only"):
        value = getattr(change, key)
        if value is not None:
            update[key] = value
    if change.return_date is not None:
        update.update(return_date=change.return_date, min_nights=None, max_nights=None)
    if change.departure_date is not None or change.return_date is not None:
        # Інші дати — інші рейси: старий вибір рейсу там не знайдеться.
        update.update(flight=None, flex_days=0, departure_until=None)
    stay_filters = current.stay_filters.model_dump()
    for field, key in (
        ("stay_min_rating", "min_rating"),
        ("stay_max_distance_km", "max_distance_center_km"),
        ("stay_free_cancellation", "free_cancellation"),
        ("stay_breakfast", "breakfast_included"),
    ):
        value = getattr(change, field)
        if value is not None:
            stay_filters[key] = value
    update["stay_filters"] = stay_filters
    return TripQuery.model_validate({**current.model_dump(), **update})
