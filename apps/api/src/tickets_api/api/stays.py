from fastapi import APIRouter, Depends, Request

from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.stay_rates import StayRatesRequest, StayRatesResult
from tickets_api.domain.stays import StayQuery
from tickets_api.services.stay_search import StaySearchResult, StaySearchService

router = APIRouter(prefix="/stays", tags=["stays"])


def _service(request: Request) -> StaySearchService:
    service: StaySearchService = request.app.state.stay_search
    return service


@router.post(
    "/search", response_model=StaySearchResult, dependencies=[Depends(rate_limit("search"))]
)
async def search_stays(query: StayQuery, request: Request) -> StaySearchResult:
    """Житло в місті на дати, з value-score і трьома рекомендованими варіантами.

    Збій окремого провайдера не дає помилку — він видно в `providers[].status`.
    """
    return await _service(request).search(query)


@router.post("/rates", response_model=StayRatesResult, dependencies=[Depends(rate_limit("search"))])
async def stay_rates(body: StayRatesRequest, request: Request) -> StayRatesResult:
    """«Порівняти ціни»: тарифи продавців на ті самі дати й гостей, згруповані за однаковими
    умовами (номер, ліжко, харчування, скасування). Джерело не вміє — `unsupported`."""
    return await _service(request).rates(body)
