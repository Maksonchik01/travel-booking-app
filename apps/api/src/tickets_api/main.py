from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from tickets_api import __version__
from tickets_api.ai.factory import build_ai_service
from tickets_api.api import (
    account,
    ai,
    alerts,
    auth,
    events,
    explore,
    flights,
    health,
    ops,
    outbound,
    places,
    shared,
    stays,
    trips,
)
from tickets_api.auth.google import GoogleOAuth
from tickets_api.core.config import Settings, get_settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.freshness import FreshnessRules
from tickets_api.llm.pricing import default_pricing, load_pricing
from tickets_api.notifications.factory import build_mailer
from tickets_api.providers.base import FlightProvider
from tickets_api.providers.fx import EcbRates
from tickets_api.providers.registry import build_providers, build_stay_providers
from tickets_api.reference.airlines import default_airline_names
from tickets_api.reference.airports import default_airport_directory
from tickets_api.reference.destinations import default_destination_directory
from tickets_api.repositories.price_history import PriceHistoryRecorder
from tickets_api.repositories.search_coverage import SearchCoverageRecorder
from tickets_api.repositories.stay_price_history import StayPriceHistoryRecorder
from tickets_api.scoring.config import default_scoring_config, load_scoring_config
from tickets_api.scoring.stays import default_stay_scoring_config, load_stay_scoring_config
from tickets_api.services.accounts import AccountService, AccountSettings
from tickets_api.services.alerts_factory import build_alert_service
from tickets_api.services.explore import ExploreService
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    # Битий конфіг скорингу має зупинити старт, а не зламати перший пошук.
    scoring_config = (
        load_scoring_config(settings.scoring_config_path)
        if settings.scoring_config_path
        else default_scoring_config()
    )
    stay_scoring_config = (
        load_stay_scoring_config(settings.stay_scoring_config_path)
        if settings.stay_scoring_config_path
        else default_stay_scoring_config()
    )
    llm_pricing = (
        load_pricing(settings.llm_pricing_path) if settings.llm_pricing_path else default_pricing()
    )
    configure_logging(settings.log_level, json=settings.log_json)
    init_sentry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = create_engine(settings.database_url)
        app.state.sessionmaker = create_sessionmaker(app.state.engine)
        # Короткі таймаути: Redis — кеш, а не причина зависати на запиті.
        app.state.redis = Redis.from_url(
            settings.redis_url, socket_timeout=1.0, socket_connect_timeout=1.0
        )
        app.state.http = httpx.AsyncClient(timeout=settings.provider_timeout_s)
        pool: dict[str, FlightProvider] = {}
        freshness = FreshnessRules(
            live_fresh_min=settings.price_live_fresh_min,
            cached_stale_days=settings.price_cached_stale_days,
        )
        app.state.flight_search = FlightSearchService(
            build_providers(
                settings.flight_providers, settings, app.state.http, app.state.redis, pool=pool
            ),
            calendar_providers=build_providers(
                settings.calendar_providers, settings, app.state.http, app.state.redis, pool=pool
            ),
            timeout_s=settings.provider_timeout_s,
            scoring_config=scoring_config,
            record_history=PriceHistoryRecorder(app.state.sessionmaker).record,
            airline_names=default_airline_names(),
            fx=EcbRates(app.state.http, app.state.redis).rate,
            live_date_pairs=settings.flex_live_date_pairs,
            freshness=freshness,
            record_coverage=SearchCoverageRecorder(app.state.redis).record,
        )
        app.state.stay_search = StaySearchService(
            build_stay_providers(
                settings.stay_providers, settings, app.state.http, app.state.redis
            ),
            airports=default_airport_directory(),
            timeout_s=settings.provider_timeout_s,
            scoring_config=stay_scoring_config,
            record_history=StayPriceHistoryRecorder(app.state.sessionmaker).record,
            freshness=freshness,
            rate=app.state.flight_search.rate,
        )
        app.state.trip_planner = TripPlanner(app.state.flight_search, app.state.stay_search)
        app.state.explore = ExploreService(
            app.state.flight_search,
            app.state.stay_search,
            airports=default_airport_directory(),
            destinations=default_destination_directory(),
        )
        app.state.alerts = build_alert_service(
            settings,
            http=app.state.http,
            redis=app.state.redis,
            sessionmaker=app.state.sessionmaker,
        )
        app.state.accounts = AccountService(
            app.state.sessionmaker,
            redis=app.state.redis,
            mailer=build_mailer(settings),
            settings=AccountSettings(
                public_web_url=settings.public_web_url.rstrip("/"),
                session_ttl_days=settings.session_ttl_days,
                login_max_failures=settings.login_max_failures,
                bot_username=settings.telegram_bot_username
                if settings.telegram_bot_token
                else None,
            ),
            google=GoogleOAuth(
                app.state.http,
                settings.google_client_id,
                settings.google_client_secret.get_secret_value(),
            )
            if settings.google_client_id and settings.google_client_secret
            else None,
        )
        app.state.ai = build_ai_service(
            settings,
            http=app.state.http,
            redis=app.state.redis,
            sessionmaker=app.state.sessionmaker,
            search=app.state.flight_search,
            stay_search=app.state.stay_search,
            trip_planner=app.state.trip_planner,
            pricing=llm_pricing,
        )
        try:
            yield
        finally:
            await app.state.http.aclose()
            await app.state.redis.aclose()
            await app.state.engine.dispose()

    app = FastAPI(title="SkyPack API", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(flights.router)
    app.include_router(explore.router)
    app.include_router(places.router)
    app.include_router(stays.router)
    app.include_router(trips.router)
    app.include_router(alerts.router)
    app.include_router(auth.router)
    app.include_router(account.router)
    app.include_router(ai.router)
    app.include_router(outbound.router)
    app.include_router(events.router)
    app.include_router(shared.router)
    app.include_router(ops.router)
    return app
