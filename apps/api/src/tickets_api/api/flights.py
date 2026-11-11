from contextlib import nullcontext
from datetime import UTC, date, datetime
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import SQLAlchemyError

from tickets_api.api.deps import note_search
from tickets_api.core.rate_limit import concurrent_searches, rate_limit
from tickets_api.domain.flights import DEFAULT_CURRENCY, Cabin, FlightQuery, Passengers
from tickets_api.domain.sellers import SellersRequest, SellersResult
from tickets_api.providers.budget import optional_spend
from tickets_api.repositories.price_series import PriceSeries, flight_series
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
    "/search",
    response_model=FlightSearchResult,
    dependencies=[Depends(rate_limit("search")), Depends(concurrent_searches)],
)
async def search_flights(query: FlightQuery, request: Request) -> FlightSearchResult:
    """Пошук у всіх увімкнених провайдерах. Ціни кешовані: дивись collected_at / found_at.

    Збій окремого провайдера не дає помилку — він видно в `providers[].status`.
    """
    result = await _service(request).search(query)
    await note_search(request, "flights", ok=bool(result.offers))
    return result


@router.get(
    "/calendar", response_model=CalendarResult, dependencies=[Depends(rate_limit("lookup"))]
)
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


@router.get("/matrix", response_model=PriceMatrix, dependencies=[Depends(rate_limit("lookup"))])
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
    dependencies=[Depends(rate_limit("check"))],
)
async def flight_sellers(body: SellersRequest, request: Request) -> SellersResult:
    """Продавці рейсу й свіжа ціна в кожного — на вимогу (1 запит квоти SerpApi, кеш 30 хв).

    Це й перевірка перед переходом: якщо ціна змінилась, UI показує нову.
    """
    # Автоматична перевірка для першої картки — необов'язкова: зупиняється раніше за пошук.
    with optional_spend() if body.auto else nullcontext():
        return await _service(request).sellers(body)


log = structlog.get_logger(__name__)


@router.get("/history", response_model=PriceSeries, dependencies=[Depends(rate_limit("lookup"))])
async def price_history(
    request: Request,
    origin: IataParam,
    destination: IataParam,
    departure: date,
    return_date: Annotated[date | None, Query(alias="return")] = None,
    adults: Annotated[int, Query(ge=1, le=9)] = 1,
    cabin: Cabin = "economy",
    currency: CurrencyParam = DEFAULT_CURRENCY,
) -> PriceSeries:
    """Історія цін на ці дати (етап 6): найнижча ціна на кожен день спостереження за 90 днів.

    Лише збережені спостереження цього складу й класу; база недоступна — порожній ряд."""
    try:
        async with request.app.state.sessionmaker() as session:
            return await flight_series(
                session,
                origin=origin,
                destination=destination,
                departure=departure,
                return_date=return_date,
                party=Passengers(adults=adults).code,
                cabin=cabin,
                currency=currency,
                today=datetime.now(UTC).date(),
            )
    except (SQLAlchemyError, OSError) as exc:
        log.warning("price_history.unavailable", error=type(exc).__name__)
        return PriceSeries(currency=currency.upper(), points=[], enough=False)
