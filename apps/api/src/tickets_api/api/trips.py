from fastapi import APIRouter, Depends, Request

from tickets_api.api.deps import note_search
from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.saved_trips import TripRefreshRequest
from tickets_api.domain.trips import TripQuery
from tickets_api.providers.budget import optional_spend
from tickets_api.services.trip_planner import (
    CheaperResult,
    TripPlanner,
    TripRefresh,
    TripSearchResult,
)

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
    result = await planner.plan(query)
    await note_search(request, "trips", ok=bool(result.combos))
    return result


@router.post("/cheaper", response_model=CheaperResult, dependencies=[Depends(rate_limit("search"))])
async def cheaper_trip(query: TripQuery, request: Request) -> CheaperResult:
    """«Знайти дешевший варіант» для «Вашої поїздки» (`flight`/`stay` у запиті): інші дати
    (±3 дні), сусідні аеропорти, інші рейси й житло за тих самих обов'язкових умов.

    Лише на вимогу: це ще один пошук перельотів (живі ціни витрачають квоту).
    """
    planner: TripPlanner = request.app.state.trip_planner
    with optional_spend():
        return await planner.cheaper(query)


@router.post("/refresh", response_model=TripRefresh, dependencies=[Depends(rate_limit("search"))])
async def refresh_trip(body: TripRefreshRequest, request: Request) -> TripRefresh:
    """«Оновити ціни» збереженої поїздки: та сама конфігурація (рейс і житло) заново —
    актуальна сума, різниця зі збереженою і чи є ще обрані рейс та житло."""
    planner: TripPlanner = request.app.state.trip_planner
    return await planner.refresh(body)
