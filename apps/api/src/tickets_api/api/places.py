from typing import Annotated

from fastapi import APIRouter, Query

from tickets_api.reference.airports import Lang, Place, default_airport_directory

router = APIRouter(prefix="/places", tags=["places"])


@router.get("", response_model=list[Place])
async def search_places(
    q: Annotated[str, Query(min_length=1, max_length=64, examples=["вар"])],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    lang: Lang = "uk",
) -> list[Place]:
    """Автодоповнення міст і аеропортів з локального довідника (без звернень до провайдерів)."""
    return default_airport_directory().search(q, limit=limit, lang=lang)
