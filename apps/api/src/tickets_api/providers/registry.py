from collections.abc import Sequence

import httpx
from redis.asyncio import Redis

from tickets_api.core.config import Settings
from tickets_api.providers.base import FlightProvider, StayProvider
from tickets_api.providers.cached import CachedFlightProvider
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.providers.scrapedo import ScrapeDoFlightProvider
from tickets_api.providers.serpapi import SerpApiFlightProvider
from tickets_api.providers.travelpayouts import TravelpayoutsFlightProvider
from tickets_api.reference.airports import default_airport_directory


def _build(
    name: str, settings: Settings, http: httpx.AsyncClient, redis: Redis
) -> FlightProvider | None:
    """Зовнішні API — за кешем Redis (ліміти й квоти); mock кешувати нема сенсу.

    Відсутні ключі відсікає валідація Settings ще на старті.
    """
    if name == "mock":
        return MockFlightProvider()
    if name == "travelpayouts" and settings.travelpayouts_token is not None:
        tp = TravelpayoutsFlightProvider(
            http,
            settings.travelpayouts_token.get_secret_value(),
            marker=settings.travelpayouts_marker,
            airports=default_airport_directory(),
            base_url=settings.travelpayouts_base_url,
        )
        return CachedFlightProvider(tp, redis, settings.provider_cache_ttl_s)
    if name == "serpapi" and settings.serpapi_key is not None:
        serp = SerpApiFlightProvider(
            http,
            settings.serpapi_key.get_secret_value(),
            airports=default_airport_directory(),
            max_requests_per_search=settings.serpapi_max_requests_per_search,
            returns_per_date=settings.serpapi_returns_per_date,
            timeout_s=settings.serpapi_timeout_s,
            request_timeout_s=settings.serpapi_request_timeout_s,
            market=settings.serpapi_market,
            base_url=settings.serpapi_base_url,
        )
        return CachedFlightProvider(serp, redis, settings.provider_cache_ttl_s)
    if name == "scrapedo" and settings.scrapedo_token is not None:
        sdo = ScrapeDoFlightProvider(
            http,
            settings.scrapedo_token.get_secret_value(),
            airports=default_airport_directory(),
            max_requests_per_search=settings.scrapedo_max_requests_per_search,
            timeout_s=settings.scrapedo_timeout_s,
            request_timeout_s=settings.scrapedo_request_timeout_s,
            market=settings.serpapi_market,
            base_url=settings.scrapedo_base_url,
        )
        return CachedFlightProvider(sdo, redis, settings.provider_cache_ttl_s)
    return None


def build_providers(
    names: Sequence[str],
    settings: Settings,
    http: httpx.AsyncClient,
    redis: Redis,
    *,
    pool: dict[str, FlightProvider] | None = None,
) -> list[FlightProvider]:
    """`pool` — спільні екземпляри: пошук і календар з одного джерела ділять ліміт одночасних
    запитів і об'єднання однакових запитів (модуль 17.2), а не мають кожен свої."""
    providers = []
    for name in dict.fromkeys(names):  # без дублів, порядок зберігається
        provider = pool.get(name) if pool is not None else None
        if provider is None:
            provider = _build(name, settings, http, redis)
            if provider is not None and pool is not None:
                pool[name] = provider
        if provider is not None:
            providers.append(provider)
    return providers


def build_stay_providers(names: Sequence[str]) -> list[StayProvider]:
    """Поки лише mock (ADR 0008); реальне джерело — ще одна гілка тут, за кешем Redis."""
    providers: list[StayProvider] = []
    for name in dict.fromkeys(names):
        if name == "mock":
            providers.append(MockStayProvider(default_airport_directory()))
    return providers
