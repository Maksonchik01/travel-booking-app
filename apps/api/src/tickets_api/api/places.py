from typing import Annotated, Literal

from fastapi import APIRouter, Query

from tickets_api.reference.airports import Lang, Place, default_airport_directory

router = APIRouter(prefix="/places", tags=["places"])


@router.get("", response_model=list[Place])
async def search_places(
    q: Annotated[str, Query(min_length=1, max_length=64, examples=["вар"])],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    lang: Lang = "uk",
    kind: Literal["any", "city"] = "any",
) -> list[Place]:
    """Автодоповнення з локального довідника (без звернень до провайдерів).

    `kind=any` — міста й аеропорти (перельоти), `kind=city` — лише міста (житло).
    """
    directory = default_airport_directory()
    if kind == "city":
        return directory.search_cities(q, limit=limit, lang=lang)
    return directory.search(q, limit=limit, lang=lang)
