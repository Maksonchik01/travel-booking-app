from fastapi import APIRouter, Request

from tickets_api.domain.stays import StayQuery
from tickets_api.services.stay_search import StaySearchResult, StaySearchService

router = APIRouter(prefix="/stays", tags=["stays"])


def _service(request: Request) -> StaySearchService:
    service: StaySearchService = request.app.state.stay_search
    return service


@router.post("/search", response_model=StaySearchResult)
async def search_stays(query: StayQuery, request: Request) -> StaySearchResult:
    """Житло в місті на дати, з value-score і трьома рекомендованими варіантами.

    Збій окремого провайдера не дає помилку — він видно в `providers[].status`.
    """
    return await _service(request).search(query)
