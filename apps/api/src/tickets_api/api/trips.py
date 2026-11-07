from fastapi import APIRouter, Depends, Request

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.trips import TripQuery
from tickets_api.services.trip_planner import TripPlanner, TripSearchResult

router = APIRouter(prefix="/trips", tags=["trips"])


@router.post(
    "/search", response_model=TripSearchResult, dependencies=[Depends(rate_limit("search"))]
)
async def search_trips(query: TripQuery, request: Request) -> TripSearchResult:
    """Переліт туди-назад + житло на дати рейсу, з загальною сумою і трьома варіантами.

    Перельоти — звичайний пошук (живі ціни витрачають квоту), житло — на дати кожного
    рекомендованого рейсу. Збій джерела видно в `providers[].status`.
    """
    planner: TripPlanner = request.app.state.trip_planner
    return await planner.plan(query)
