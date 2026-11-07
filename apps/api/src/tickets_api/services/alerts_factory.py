"""Збирання AlertService з налаштувань — спільне для API і воркера."""

from decimal import Decimal

import httpx
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tickets_api.core.config import Settings
from tickets_api.domain.flights import FlightQuery
from tickets_api.notifications.mail import Mailer, MockMailer, SmtpMailer
from tickets_api.notifications.telegram import MockTelegram, TelegramBot, TelegramClient
from tickets_api.providers.registry import build_providers
from tickets_api.repositories.price_history import (
    PriceHistoryRecorder,
    PriceStats,
    route_price_stats,
)
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.alerts import AlertService, AlertSettings
from tickets_api.services.flight_search import FlightSearchService


def build_alert_service(
    settings: Settings,
    *,
    http: httpx.AsyncClient,
    redis: Redis,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> AlertService:
    # Окремий пошук з кешованим джерелом: перевірки не витрачають квоту живих цін.
    search = FlightSearchService(
        build_providers(settings.alert_providers, settings, http, redis),
        calendar_providers=[],
        timeout_s=settings.provider_timeout_s,
        scoring_config=default_scoring_config(),
        record_history=PriceHistoryRecorder(sessionmaker).record,
    )
    telegram: TelegramClient = (
        TelegramBot(
            http,
            settings.telegram_bot_token.get_secret_value(),
            base_url=settings.telegram_base_url,
        )
        if settings.telegram_bot_token is not None
        else MockTelegram()
    )
    mailer: Mailer = (
        SmtpMailer(
            settings.smtp_host,
            settings.smtp_port,
            user=settings.smtp_user,
            password=settings.smtp_password.get_secret_value() if settings.smtp_password else None,
            sender=settings.email_from,
        )
        if settings.smtp_host and settings.email_from
        else MockMailer()
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

    return AlertService(
        sessionmaker,
        search=search,
        telegram=telegram,
        mailer=mailer,
        settings=AlertSettings(
            public_web_url=settings.public_web_url.rstrip("/"),
            bot_username=settings.telegram_bot_username,
            min_hours_between_notifications=settings.alert_min_hours_between_notifications,
        ),
        redis=redis,
        price_stats=price_stats,
    )
