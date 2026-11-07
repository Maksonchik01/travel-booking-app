from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.flights import DEFAULT_CURRENCY, FlightQuery
from tickets_api.domain.sellers import SellersRequest, SellersResult
from tickets_api.services.flight_search import (
    CalendarResult,
    FlightSearchResult,
    FlightSearchService,
    PriceMatrix,
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


MATRIX_MAX_DAYS = 14


@router.get("/matrix", response_model=PriceMatrix)
async def price_matrix(
    request: Request,
    origin: IataParam,
    destination: IataParam,
    depart_from: date,
    depart_to: date,
    return_from: date,
    return_to: date,
    currency: CurrencyParam = DEFAULT_CURRENCY,
) -> PriceMatrix:
    """Матриця туди-назад: виліт × повернення, у клітинці — загальна ціна (кешована,
    орієнтовна, за одного дорослого). До 14 днів по кожній осі; живих запитів не робить."""
    for a, b in ((depart_from, depart_to), (return_from, return_to)):
        if not 0 <= (b - a).days < MATRIX_MAX_DAYS:
            raise HTTPException(status_code=422, detail=f"діапазон дат — до {MATRIX_MAX_DAYS} днів")
    if return_to < depart_from:
        raise HTTPException(status_code=422, detail="повернення раніше за виліт")
    return await _service(request).matrix(
        origin.upper(),
        destination.upper(),
        (depart_from, depart_to),
        (return_from, return_to),
        currency.upper(),
    )


@router.post(
    "/sellers",
    response_model=SellersResult,
    dependencies=[Depends(rate_limit("search"))],
)
async def flight_sellers(body: SellersRequest, request: Request) -> SellersResult:
    """Продавці рейсу й свіжа ціна в кожного — на вимогу (1 запит квоти SerpApi, кеш 30 хв).

    Це й перевірка перед переходом: якщо ціна змінилась, UI показує нову.
    """
    return await _service(request).sellers(body)
