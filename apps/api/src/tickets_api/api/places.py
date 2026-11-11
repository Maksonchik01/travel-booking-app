from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from tickets_api.core.rate_limit import rate_limit
from tickets_api.providers.geocoder import GeocodeError, GeoPlace, NominatimGeocoder
from tickets_api.reference.airports import (
    Lang,
    Place,
    default_airport_directory,
    default_country_codes,
)

router = APIRouter(prefix="/places", tags=["places"])


@router.get("", response_model=list[Place], dependencies=[Depends(rate_limit("lookup"))])
async def search_places(
    q: Annotated[str, Query(min_length=1, max_length=64, examples=["вар"])],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    lang: Lang = "uk",
    kind: Literal["any", "city"] = "any",
) -> list[Place]:
    """Автодоповнення з локального довідника (без звернень до провайдерів).

    `kind=any` — міста й аеропорти (перельоти), `kind=city` — лише міста (житло).
    """
    directory = default_airport_directory()
    if kind == "city":
        return directory.search_cities(q, limit=limit, lang=lang)
    return directory.search(q, limit=limit, lang=lang)


@router.get("/countries", response_model=list[str], dependencies=[Depends(rate_limit("lookup"))])
async def countries() -> list[str]:
    """Коди країн довідника (ISO 3166-1 alpha-2); назви мовою сторінки підставляє веб."""
    return default_country_codes()


class GeocodeResult(BaseModel):
    status: Literal["ok", "error"]
    places: list[GeoPlace]


@router.get("/geocode", response_model=GeocodeResult, dependencies=[Depends(rate_limit("search"))])
async def geocode(
    request: Request,
    q: Annotated[str, Query(min_length=2, max_length=120)],
    city: Annotated[str, Query(pattern=r"^[A-Za-z]{3}$")],
    lang: Lang = "uk",
) -> GeocodeResult:
    """Адреса чи визначна точка в місті пошуку житла (ADR 0049) — OpenStreetMap Nominatim.

    Лише за натисканням «Знайти» (без автодоповнення), кеш 30 днів; текст запиту не логуємо.
    Збій джерела — `error` і порожній список: пошук житла від цього не ламається."""
    geocoder: NominatimGeocoder = request.app.state.geocoder
    place = default_airport_directory().city_of(city)
    center = (place.lat, place.lon) if place else None
    try:
        places = await geocoder.search(q, center=center, lang=lang)
    except GeocodeError:
        return GeocodeResult(status="error", places=[])
    return GeocodeResult(status="ok", places=places)
