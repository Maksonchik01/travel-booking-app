from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from tickets_api import __version__
from tickets_api.api import health
from tickets_api.core.config import Settings, get_settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry
from tickets_api.db.session import create_engine, create_sessionmaker


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, json=settings.log_json)
    init_sentry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = create_engine(settings.database_url)
        app.state.sessionmaker = create_sessionmaker(app.state.engine)
        app.state.redis = Redis.from_url(settings.redis_url)
        try:
            yield
        finally:
            await app.state.redis.aclose()
            await app.state.engine.dispose()

    app = FastAPI(title="Tickets API", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    return app
