import time
from datetime import UTC, date, datetime
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.exc import SQLAlchemyError

from tickets_api.api.deps import note_search
from tickets_api.core.rate_limit import concurrent_searches, rate_limit
from tickets_api.domain.stay_rates import StayRatesRequest, StayRatesResult
from tickets_api.domain.stays import StayQuery
from tickets_api.providers.budget import optional_spend
from tickets_api.repositories.price_series import PriceSeries, stay_series
from tickets_api.services.stay_search import (
    StayDetailRequest,
    StayDetailResult,
    StaySearchResult,
    StaySearchService,
)

router = APIRouter(prefix="/stays", tags=["stays"])


def _service(request: Request) -> StaySearchService:
    service: StaySearchService = request.app.state.stay_search
    return service


@router.post(
    "/search",
    response_model=StaySearchResult,
    dependencies=[Depends(rate_limit("search")), Depends(concurrent_searches)],
)
async def search_stays(query: StayQuery, request: Request) -> StaySearchResult:
    """Житло в місті на дати, з value-score і трьома рекомендованими варіантами.

    Збій окремого провайдера не дає помилку — він видно в `providers[].status`.
    """
    started = time.monotonic()
    result = await _service(request).search(query)
    await note_search(request, "stays", ok=bool(result.stays), started=started)
    return result


@router.post("/rates", response_model=StayRatesResult, dependencies=[Depends(rate_limit("check"))])
async def stay_rates(body: StayRatesRequest, request: Request) -> StayRatesResult:
    """«Порівняти ціни»: тарифи продавців на ті самі дати й гостей, згруповані за однаковими
    умовами (номер, ліжко, харчування, скасування). Джерело не вміє — `unsupported`."""
    # Сторінка об'єкта вантажить тарифи сама — необов'язкова витрата (ADR 0055).
    with optional_spend():
        return await _service(request).rates(body)


@router.post(
    "/detail", response_model=StayDetailResult, dependencies=[Depends(rate_limit("lookup"))]
)
async def stay_detail(body: StayDetailRequest, request: Request) -> StayDetailResult:
    """Сторінка об'єкта: фото, опис, деталі — з видачі тих самих дат і гостей (з кешу пошуку)."""
    return await _service(request).detail(body)


log = structlog.get_logger(__name__)


@router.get("/history", response_model=PriceSeries, dependencies=[Depends(rate_limit("lookup"))])
async def stay_history(
    request: Request,
    source: Annotated[str, Query(pattern=r"^[a-z0-9_]{1,32}$")],
    stay_id: Annotated[str, Query(min_length=1, max_length=128)],
    check_in: Annotated[date, Query(alias="in")],
    check_out: Annotated[date, Query(alias="out")],
    guests: Annotated[int, Query(ge=1, le=17)] = 2,
    currency: Annotated[str, Query(pattern=r"^[A-Za-z]{3}$")] = "EUR",
) -> PriceSeries:
    """Історія ціни об'єкта на ці дати (етап 6): найнижча сума видачі на кожен день."""
    try:
        async with request.app.state.sessionmaker() as session:
            return await stay_series(
                session,
                source=source,
                stay_id=stay_id,
                check_in=check_in,
                check_out=check_out,
                guests=guests,
                currency=currency,
                today=datetime.now(UTC).date(),
            )
    except (SQLAlchemyError, OSError) as exc:
        log.warning("stay_history.unavailable", error=type(exc).__name__)
        return PriceSeries(currency=currency.upper(), points=[], enough=False)
