from fastapi import APIRouter, Depends, HTTPException, Path

from tickets_api.api.deps import Service
from tickets_api.core.rate_limit import rate_limit
from tickets_api.domain.saved_trips import SharedTrip

router = APIRouter(prefix="/shared", tags=["shared"])


@router.get(
    "/trips/{token}",
    response_model=SharedTrip,
    dependencies=[Depends(rate_limit("clicks"))],
)
async def shared_trip(
    service: Service,
    token: str = Path(pattern=r"^[A-Za-z0-9_-]{16,40}$"),
) -> SharedTrip:
    """Публічний перегляд поїздки за посиланням власника (модуль 20.2). Без входу; лише сама
    поїздка — без власника й особистого. Посилання вимкнули чи його не було — 404."""
    trip = await service.shared_trip(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="not_found")
    return trip
