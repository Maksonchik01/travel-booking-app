from fastapi import APIRouter, Depends, Request

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.explore import ExploreQuery
from tickets_api.services.explore import ExploreResult, ExploreService

router = APIRouter(prefix="/explore", tags=["explore"])


@router.post("", response_model=ExploreResult, dependencies=[Depends(rate_limit("search"))])
async def explore(query: ExploreQuery, request: Request) -> ExploreResult:
    """Напрямки за бюджетом (ADR 0045): кешовані ціни перельотів з міста будь-куди.

    Живих запитів перельотів немає; житло (режим `trip`) — лише для кількох найдешевших.
    """
    service: ExploreService = request.app.state.explore
    return await service.explore(query)
