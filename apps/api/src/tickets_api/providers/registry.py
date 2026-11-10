from collections.abc import Sequence

import httpx
from redis.asyncio import Redis

from tickets_api.core.config import Settings
from tickets_api.providers.base import FlightProvider, StayProvider
from tickets_api.providers.cached import CachedFlightProvider, CachedStayProvider
from tickets_api.providers.mock import MockFlightProvider
from tickets_api.providers.mock_stays import MockStayProvider
from tickets_api.providers.scrapedo import ScrapeDoFlightProvider
from tickets_api.providers.scrapedo_stays import ScrapeDoStayProvider
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


def build_stay_providers(
    names: Sequence[str],
    settings: Settings | None = None,
    http: httpx.AsyncClient | None = None,
    redis: Redis | None = None,
) -> list[StayProvider]:
    """mock (ADR 0008) і scrape.do Google Hotels (ADR 0044) — за кешем Redis: пошук платний, а
    сторінка об'єкта й тарифи беруть його з кешу. Без ключа чи клієнтів платне не будуємо."""
    providers: list[StayProvider] = []
    for name in dict.fromkeys(names):
        if name == "mock":
            providers.append(MockStayProvider(default_airport_directory()))
        elif (
            name == "scrapedo"
            and settings is not None
            and settings.scrapedo_token is not None
            and http is not None
            and redis is not None
        ):
            hotels = ScrapeDoStayProvider(
                http,
                settings.scrapedo_token.get_secret_value(),
                airports=default_airport_directory(),
                timeout_s=settings.scrapedo_timeout_s,
                market=settings.serpapi_market,
                base_url=settings.scrapedo_base_url,
            )
            cached = CachedStayProvider(hotels, redis, settings.provider_cache_ttl_s)
            hotels.lookup = cached.search  # тарифи — з кешу пошуку, без нового запиту
            providers.append(cached)
    return providers
