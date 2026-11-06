from decimal import Decimal

import httpx
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.ai.assistant import TravelAssistant
from tickets_api.ai.explainer import FlightExplainer
from tickets_api.ai.parser import QueryParser
from tickets_api.ai.service import AIService
from tickets_api.ai.stay_analyst import StayAnalyst
from tickets_api.core.config import Settings
from tickets_api.domain.flights import FlightQuery
from tickets_api.llm.deepseek import DeepSeekClient
from tickets_api.llm.metered import LLMUsageRecorder
from tickets_api.llm.mock import MockLLMClient
from tickets_api.llm.pricing import Pricing
from tickets_api.llm.types import LLMClient
from tickets_api.reference.airports import default_airport_directory
from tickets_api.repositories.price_history import PriceStats, route_price_stats
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.stay_search import StaySearchService
from tickets_api.services.trip_planner import TripPlanner


def build_ai_service(
    settings: Settings,
    *,
    http: httpx.AsyncClient,
    redis: Redis,
    sessionmaker: async_sessionmaker[AsyncSession],
    search: FlightSearchService,
    pricing: Pricing,
    stay_search: StaySearchService | None = None,
    trip_planner: TripPlanner | None = None,
) -> AIService | None:
    """None — ШІ вимкнено (LLM_PROVIDER=off): ендпоінти /ai/* відповідають 503."""
    client: LLMClient
    if settings.llm_provider == "off":
        return None
    if settings.llm_provider == "mock":
        client = MockLLMClient()
    else:
        if settings.deepseek_api_key is None:  # Settings це вже відсікає; тут — для типів
            raise ValueError("LLM_PROVIDER=deepseek без DEEPSEEK_API_KEY")
        client = DeepSeekClient(
            http,
            settings.deepseek_api_key.get_secret_value(),
            base_url=settings.deepseek_base_url,
            timeout_s=settings.llm_timeout_s,
        )

    async def price_stats(query: FlightQuery, best_price: Decimal) -> PriceStats | None:
        async with sessionmaker() as session:
            return await route_price_stats(
                session,
                origin=query.origin,
                destination=query.destination,
                departure=query.departure_date,
                round_trip=query.return_date is not None,
                currency=query.currency,
                best_price=best_price,
            )

    service: AIService
    airports = default_airport_directory()
    parser = QueryParser(
        airports,
        model=settings.llm_model_parser,
        cheapest_day=lambda *args: service.cheapest_day(*args),
        prompts_dir=settings.llm_prompts_dir,
    )
    service = AIService(
        client,
        parser=parser,
        explainer=FlightExplainer(
            model=settings.llm_model_explainer, prompts_dir=settings.llm_prompts_dir
        ),
        search=search,
        pricing=pricing,
        max_calls=settings.llm_max_calls_per_search,
        assistant=TravelAssistant(
            airports,
            search,
            model=settings.llm_model_assistant,
            stay_search=stay_search,
            trip_planner=trip_planner,
            prompts_dir=settings.llm_prompts_dir,
        ),
        chat_max_calls=settings.llm_max_calls_per_chat_turn,
        stay_search=stay_search,
        # Відгуки — потужніша модель, як і пояснення перельотів.
        stay_analyst=StayAnalyst(
            model=settings.llm_model_explainer, prompts_dir=settings.llm_prompts_dir
        ),
        redis=redis,
        cache_ttl_s=settings.llm_cache_ttl_s,
        record_usage=LLMUsageRecorder(sessionmaker).record,
        price_stats=price_stats,
        cache_namespace=client.name,
    )
    return service
