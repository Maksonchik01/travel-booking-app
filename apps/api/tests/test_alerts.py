"""Алерти: підписка, підтвердження (Telegram /start, email), перевірка цін, антиспам.

Працюють з Postgres (маркер integration): make test-integration або CI.
"""

import os
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from flight_fakes import FakeRedis, StubProvider, offers_for
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.db.models import Alert, AlertEvent
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.alerts import AlertCreate
from tickets_api.domain.flights import FlightQuery
from tickets_api.notifications.mail import MockMailer
from tickets_api.notifications.telegram import MockTelegram
from tickets_api.repositories.price_history import PriceStats
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.alerts import (
    UNKNOWN_LINK_TEXT,
    AlertError,
    AlertService,
    AlertSettings,
)
from tickets_api.services.flight_search import FlightSearchService

pytestmark = pytest.mark.integration

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
DEPART = date(2026, 11, 10)  # дата, на яку StubProvider дає рейси (offers_for)


class Env:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.now = NOW
        self.provider = StubProvider("stub", offers=offers_for("stub", [88, 120]))
        self.telegram = MockTelegram()
        self.mailer = MockMailer()
        self.redis = FakeRedis()
        self.stats: PriceStats | None = None
        self.created: list[str] = []

        async def stats(query: FlightQuery, best: Decimal) -> PriceStats | None:
            return self.stats

        self.service = AlertService(
            sessionmaker,
            search=FlightSearchService(
                [self.provider], timeout_s=1, scoring_config=default_scoring_config()
            ),
            telegram=self.telegram,
            mailer=self.mailer,
            settings=AlertSettings(
                public_web_url="https://tickets.example",
                bot_username="flyandbookbot",
                min_hours_between_notifications=24,
            ),
            redis=self.redis,  # type: ignore[arg-type]
            price_stats=stats,
            clock=lambda: self.now,
        )

    async def create(self, **fields: Any) -> Any:
        body: dict[str, Any] = {
            "origin": "WAW",
            "destination": "LIS",
            "departure_date": DEPART,
            "threshold": 100,
        }
        body.update(fields)
        created = await self.service.create(AlertCreate.model_validate(body))
        self.created.append(created.id)
        return created

    async def start(self, token: str, chat_id: int = 42) -> None:
        update = {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": f"/start {token}"}}
        await self.service.handle_telegram_update(update)


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    sessionmaker = create_sessionmaker(engine)
    e = Env(sessionmaker)
    yield e
    async with sessionmaker() as session, session.begin():
        await session.execute(delete(AlertEvent).where(AlertEvent.alert_id.in_(e.created)))
        await session.execute(delete(Alert).where(Alert.id.in_(e.created)))
    await engine.dispose()


async def test_telegram_subscription_is_confirmed_by_start_link(env: Env) -> None:
    created = await env.create()

    assert created.status == "pending"
    assert created.telegram_link == f"https://t.me/flyandbookbot?start={created.manage_token}"
    assert len(created.manage_token) <= 64

    await env.start(created.manage_token)

    view = await env.service.view(created.manage_token)
    assert view is not None
    assert view.status == "active"
    chat_id, text, buttons = env.telegram.sent[0]
    assert chat_id == 42
    assert "Підписку підтверджено" in text
    # Одразу після підтвердження — перша перевірка: 88 ≤ 100, тож сповіщення вже прийшло.
    assert "Ціна знизилась" in env.telegram.sent[1][1]
    assert buttons == [
        ("Керувати підпискою", f"https://tickets.example/alerts?token={created.manage_token}")
    ]
    # Посилання одноразове: повторний /start не перепривʼязує підписку.
    await env.start(created.manage_token, chat_id=7)
    assert env.telegram.sent[-1][1] == UNKNOWN_LINK_TEXT


async def test_email_subscription_needs_confirmation_link(env: Env) -> None:
    created = await env.create(channel="email", email="me@example.com")

    to, subject, text = env.mailer.sent[-1]
    assert (to, subject) == ("me@example.com", "Підтвердіть підписку на ціну")
    assert f"/alerts?token={created.manage_token}" in text
    # Без підтвердження перевірки не надсилають нічого.
    assert await env.service.check_all() == 0

    view = await env.service.confirm_email(created.manage_token)

    assert view is not None
    assert view.status == "active"
    # Перша перевірка — одразу після підтвердження.
    assert view.last_notified_price == Decimal(88)
    assert env.mailer.sent[-1][1] == "Ціна знизилась: WAW → LIS, 10.11.2026"


async def test_price_drop_notifies_once_then_only_lower_and_not_too_often(env: Env) -> None:
    created = await env.create(threshold=100)
    await env.start(created.manage_token)  # перша перевірка — одразу, вже зі сповіщенням

    text = env.telegram.sent[-1][1]
    assert "Зараз від 88 EUR за дорослого — нижче вашого порогу 100 EUR" in text
    assert "https://tickets.example/?from=WAW&to=LIS&depart=2026-11-10" in text

    # Та сама ціна — мовчимо; нижча, але менш ніж за добу — теж.
    assert await env.service.check(created.id) == 0
    env.provider._offers = offers_for("stub", [80])
    env.now = NOW + timedelta(hours=3)
    assert await env.service.check(created.id) == 0
    # Через добу й нижча — сповіщаємо.
    env.now = NOW + timedelta(hours=25)
    assert await env.service.check(created.id) == 1
    view = await env.service.view(created.manage_token)
    assert view is not None
    assert view.last_notified_price == Decimal(80)


async def test_condition_not_met_and_typical_price_needs_history(env: Env) -> None:
    cheap_threshold = await env.create(threshold=50)
    typical = await env.create(condition="below_typical", threshold=None)
    await env.start(cheap_threshold.manage_token)
    await env.start(typical.manage_token, chat_id=43)

    assert await env.service.check(cheap_threshold.id) == 0  # 88 > 50

    env.stats = PriceStats(
        median=Decimal(120),
        p25=Decimal(100),
        p75=Decimal(140),
        percentile_of_best_offer=5,
        sample_size=12,
        days_covered=10,
        currency="EUR",
    )
    assert await env.service.check(typical.id) == 0  # замало історії
    env.stats = env.stats.model_copy(update={"sample_size": 40})
    assert await env.service.check(typical.id) == 1  # 88 ≤ 120 × 0,9
    assert "нижче типової для маршруту ціни 120 EUR" in env.telegram.sent[-1][1]


async def test_past_dates_expire_and_stop_works(env: Env) -> None:
    created = await env.create()
    other = await env.create()
    await env.start(created.manage_token)

    env.now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    assert await env.service.check(created.id) == 0
    view = await env.service.view(created.manage_token)
    assert view is not None
    assert view.status == "expired"

    stopped = await env.service.stop(other.manage_token)
    assert stopped is not None
    assert stopped.status == "stopped"
    with pytest.raises(AlertError):
        await env.create(departure_date=date(2026, 11, 1))


async def test_bot_commands_and_polling_offset(env: Env) -> None:
    created = await env.create()
    env.telegram.updates = [
        {
            "update_id": 10,
            "message": {"chat": {"id": 42}, "text": f"/start {created.manage_token}"},
        },
        {"update_id": 11, "message": {"chat": {"id": 42}, "text": "/list"}},
        {"update_id": 12, "message": {"chat": {"id": 42}, "text": "привіт"}},
        {"update_id": 13, "message": {"chat": {"id": 42}, "text": "/stop"}},
    ]

    assert await env.service.poll_telegram() == 4

    texts = [text for _, text, _ in env.telegram.sent]
    assert "Підписку підтверджено" in texts[0]
    assert "Ціна знизилась" in texts[1]  # перша перевірка одразу після підтвердження
    assert "WAW → LIS, 10.11.2026" in texts[2]
    assert "/list" in texts[3]  # довідка на звичайний текст
    assert texts[4] == "Готово: вимкнено підписок — 1."
    assert int(env.redis.store["alerts:telegram:offset"]) == 14
    # Підтверджені оновлення не обробляються вдруге.
    assert await env.service.poll_telegram() == 0
