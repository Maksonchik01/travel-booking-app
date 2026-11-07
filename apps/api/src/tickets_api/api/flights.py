from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.flights import DEFAULT_CURRENCY, FlightQuery
from tickets_api.services.flight_search import (
    CalendarResult,
    FlightSearchResult,
    FlightSearchService,
)

router = APIRouter(prefix="/flights", tags=["flights"])

IataParam = Annotated[str, Query(pattern=r"^[A-Za-z]{3}$", examples=["WAW"])]
MonthParam = Annotated[str, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$", examples=["2026-11"])]
CurrencyParam = Annotated[str, Query(pattern=r"^[A-Za-z]{3}$")]


def _service(request: Request) -> FlightSearchService:
    service: FlightSearchService = request.app.state.flight_search
    return service


@router.post(
    "/search", response_model=FlightSearchResult, dependencies=[Depends(rate_limit("search"))]
)
async def search_flights(query: FlightQuery, request: Request) -> FlightSearchResult:
    """Пошук у всіх увімкнених провайдерах. Ціни кешовані: дивись collected_at / found_at.

    Збій окремого провайдера не дає помилку — він видно в `providers[].status`.
    """
    return await _service(request).search(query)


@router.get("/calendar", response_model=CalendarResult)
async def price_calendar(
    request: Request,
    origin: IataParam,
    destination: IataParam,
    month: MonthParam,
    currency: CurrencyParam = DEFAULT_CURRENCY,
) -> CalendarResult:
    """Найнижча відома ціна на кожен день місяця (в один бік)."""
    month_start = date.fromisoformat(f"{month}-01")
    return await _service(request).calendar(
        origin.upper(), destination.upper(), month_start, currency.upper()
    )
