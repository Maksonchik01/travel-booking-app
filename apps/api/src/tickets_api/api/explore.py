from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.explore import DestinationPhoto, ExploreCategory, ExploreQuery
from tickets_api.reference.destinations import category_covers, default_destination_directory
from tickets_api.services.explore import ExploreResult, ExploreService

router = APIRouter(prefix="/explore", tags=["explore"])


@router.post("", response_model=ExploreResult, dependencies=[Depends(rate_limit("search"))])
async def explore(query: ExploreQuery, request: Request) -> ExploreResult:
    """Напрямки за бюджетом (ADR 0045): кешовані ціни перельотів з міста будь-куди.

    Живих запитів перельотів немає; житло (режим `trip`) — лише для кількох найдешевших.
    """
    service: ExploreService = request.app.state.explore
    return await service.explore(query)


class CategoryCover(BaseModel):
    category: ExploreCategory
    city: str
    photo: DestinationPhoto


@router.get("/categories", response_model=list[CategoryCover])
async def categories() -> list[CategoryCover]:
    """Категорії подорожей з обкладинками (етап 9) — для головної; з довідника, без запитів."""
    return [
        CategoryCover(category=category, city=city, photo=photo)
        for category, city, photo in category_covers(default_destination_directory())
    ]
