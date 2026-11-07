from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.db.models import OutboundClick
from tickets_api.domain.outbound import ClickIn


async def record_click(sessionmaker: async_sessionmaker[AsyncSession], click: ClickIn) -> None:
    async with sessionmaker() as session:
        session.add(OutboundClick(kind=click.kind, source=click.source, host=click.host))
        await session.commit()
