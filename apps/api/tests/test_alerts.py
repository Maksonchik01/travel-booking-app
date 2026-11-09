"""Алерти: підписка, підтвердження (Telegram /start, email), перевірка цін, антиспам, бот.

Працюють з Postgres (маркер integration): make test-integration або CI.
"""

import os
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from flight_fakes import FakeRedis, StubProvider, offers_for
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.db.models import Alert, AlertEvent, AuthToken, User
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.alerts import AlertCreate, AlertEdit
from tickets_api.domain.flights import FlightQuery, Leg, Offer
from tickets_api.domain.notify import NotifyPrefs
from tickets_api.notifications.mail import MockMailer
from tickets_api.notifications.telegram import MockTelegram
from tickets_api.reference.airports import default_airport_directory
from tickets_api.repositories.price_history import PriceStats
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.accounts import token_hash
from tickets_api.services.alerts import AlertError, AlertService, AlertSettings, Found
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.telegram_bot import (
    COMMANDS,
    UNKNOWN_LINK_TEXT,
    TelegramBotService,
    parse_amount,
    parse_date,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
DEPART = date(2026, 11, 10)  # дата, на яку StubProvider дає рейси (offers_for)
CHATS = (42, 43, 7)
USER_ID = "ittest-user"


class Env:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.now = NOW
        self.sessionmaker = sessionmaker
        self.provider = StubProvider("stub", offers=offers_for("stub", [88, 120]))
        self.telegram = MockTelegram()
        self.mailer = MockMailer()
        self.redis = FakeRedis()
        self.stats: PriceStats | None = None
        self.created: list[str] = []
        self.update_id = 100

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
            price_stats=stats,
            clock=lambda: self.now,
        )
        self.bot = TelegramBotService(
            self.service,
            sessionmaker,
            redis=self.redis,  # type: ignore[arg-type]
            airports=default_airport_directory(),
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

    async def say(self, text: str, chat_id: int = 42) -> None:
        self.update_id += 1
        message = {"chat": {"id": chat_id}, "text": text}
        await self.bot.handle({"update_id": self.update_id, "message": message})

    async def press(self, data: str, chat_id: int = 42) -> None:
        self.update_id += 1
        callback = {"id": f"cb{self.update_id}", "data": data, "message": {"chat": {"id": chat_id}}}
        await self.bot.handle({"update_id": self.update_id, "callback_query": callback})

    def texts(self) -> list[str]:
        return [m.text for m in self.telegram.sent]

    def last(self) -> str:
        return self.telegram.sent[-1].text

    def callbacks(self, index: int = -1) -> list[str]:
        return [b.data for row in self.telegram.sent[index].keyboard for b in row if b.data]


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    sessionmaker = create_sessionmaker(engine)
    e = Env(sessionmaker)

    async def cleanup() -> None:
        async with sessionmaker() as session, session.begin():
            chat_alerts = select(Alert.id).where(Alert.telegram_chat_id.in_(CHATS))
            ids = [*(await session.scalars(chat_alerts)).all(), *e.created]
            await session.execute(delete(AlertEvent).where(AlertEvent.alert_id.in_(ids)))
            await session.execute(delete(Alert).where(Alert.id.in_(ids)))
            await session.execute(delete(AuthToken).where(AuthToken.user_id == USER_ID))
            await session.execute(delete(User).where(User.id == USER_ID))

    await cleanup()
    yield e
    await cleanup()
    await engine.dispose()


async def test_telegram_subscription_is_confirmed_by_start_link(env: Env) -> None:
    created = await env.create()

    assert created.status == "pending"
    assert created.telegram_link == f"https://t.me/flyandbookbot?start={created.manage_token}"
    assert len(created.manage_token) <= 64

    await env.say(f"/start {created.manage_token}")

    view = await env.service.view(created.manage_token)
    assert view is not None
    assert view.status == "active"
    confirmation, drop = env.telegram.sent[0], env.telegram.sent[1]
    assert confirmation.chat_id == 42
    assert confirmation.html
    assert "Підписку підтверджено" in confirmation.text
    assert f"stop:{created.id}" in env.callbacks(0)
    # Одразу після підтвердження — перша перевірка: 88 ≤ 100, тож сповіщення вже прийшло.
    assert "Ціна знизилась" in drop.text
    assert f"snooze:{created.id}" in env.callbacks(1)
    # Посилання одноразове: повторний /start не перепривʼязує підписку.
    await env.say(f"/start {created.manage_token}", chat_id=7)
    assert env.last() == UNKNOWN_LINK_TEXT


async def test_email_subscription_needs_confirmation_link(env: Env) -> None:
    created = await env.create(channel="email", email="me@example.com")

    to, subject, text = env.mailer.sent[-1]
    assert (to, subject) == ("me@example.com", "Підтвердіть підписку на ціну")
    assert f"/alerts?token={created.manage_token}" in text
    assert await env.service.check(created.id) == 0  # без підтвердження — нічого

    view = await env.service.confirm_email(created.manage_token)

    assert view is not None
    assert view.status == "active"
    assert view.last_notified_price == Decimal(88)  # перша перевірка — одразу
    assert env.mailer.sent[-1][1] == "Ціна знизилась: WAW → LIS, 10.11.2026"


async def test_price_drop_notifies_once_then_only_lower_and_not_too_often(env: Env) -> None:
    created = await env.create(threshold=100)
    await env.say(f"/start {created.manage_token}")  # перша перевірка — зі сповіщенням

    assert "Зараз від <b>88 EUR</b> за 1 дорослого — не дорожче за ваш поріг 100 EUR" in env.last()

    assert await env.service.check(created.id) == 0  # та сама ціна — мовчимо
    env.provider._offers = offers_for("stub", [87])
    env.now = NOW + timedelta(hours=25)
    assert await env.service.check(created.id) == 0  # −1 EUR — не нова істотна зміна (< 3%)
    env.provider._offers = offers_for("stub", [80])
    env.now = NOW + timedelta(hours=3)
    assert await env.service.check(created.id) == 0  # нижча, але менш ніж за добу
    env.now = NOW + timedelta(hours=25)
    assert await env.service.check(created.id) == 1
    assert "Минулого разу писали про 88 EUR: ще на 8 EUR дешевше." in env.last()


async def test_owner_notification_settings_hold_and_release(env: Env) -> None:
    """Налаштування сповіщень акаунта (10c): тиша, мін. зниження, канал — перевіряє воркер."""
    prefs = NotifyPrefs(quiet_start=11, quiet_end=14, timezone="Europe/Warsaw", min_drop_percent=10)
    async with env.sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_np", notify_prefs=prefs.model_dump_json()))
    created = await env.create(threshold=100)
    async with env.sessionmaker() as session, session.begin():
        alert = await session.get(Alert, created.id)
        assert alert is not None
        alert.user_id = USER_ID
    # 12:00 UTC = 13:00 у Варшаві — тихі години: підтвердження є, сповіщення ще ні.
    await env.say(f"/start {created.manage_token}")
    assert not any("Ціна знизилась" in t for t in env.texts())

    env.now = NOW + timedelta(hours=2)  # 15:00 у Варшаві
    assert await env.service.check(created.id) == 1

    env.provider._offers = offers_for("stub", [84])  # −4.5% — менше за 10%
    env.now = NOW + timedelta(hours=30)
    assert await env.service.check(created.id) == 0
    env.provider._offers = offers_for("stub", [75])  # −15%
    assert await env.service.check(created.id) == 1

    async with env.sessionmaker() as session, session.begin():
        user = await session.get(User, USER_ID)
        assert user is not None
        user.notify_prefs = NotifyPrefs(telegram=False).model_dump_json()
    env.provider._offers = offers_for("stub", [60])
    env.now = NOW + timedelta(hours=60)
    assert await env.service.check(created.id) == 0
    async with env.sessionmaker() as session:
        held = (
            await session.scalars(
                select(AlertEvent.detail).where(
                    AlertEvent.alert_id == created.id, AlertEvent.kind == "held"
                )
            )
        ).all()
    assert held == ["quiet_hours", "small_drop", "channel_off"]


def round_trip(oid: str, price: int, out: datetime, back: datetime) -> Offer:
    leg = offers_for("stub", [price])[0]
    return leg.model_copy(
        update={
            "id": oid,
            "outbound": leg.outbound.model_copy(update={"departure_at": out}),
            "inbound": Leg(
                origin="LIS", destination="WAW", departure_at=back, duration_min=240, stops=0
            ),
        }
    )


async def test_flexible_weekends_drop_percent_and_baggage_note(env: Env) -> None:
    """11a: «будь-які вихідні», зниження на % від першої перевірки, чесна примітка про багаж."""
    friday = datetime(2026, 11, 13, 7, tzinfo=UTC)
    tuesday = datetime(2026, 11, 17, 7, tzinfo=UTC)
    env.provider._offers = [
        round_trip("weekday", 60, tuesday, tuesday + timedelta(days=2)),  # дешевше, але не вихідні
        round_trip("weekend", 100, friday, friday + timedelta(days=2)),
    ]
    created = await env.create(
        kind="flex",
        departure_date=date(2026, 11, 9),
        departure_until=date(2026, 11, 30),
        min_nights=1,
        max_nights=3,
        weekends=True,
        baggage="carry_on",
        condition="drop_percent",
        percent=10,
        threshold=None,
    )
    await env.say(f"/start {created.manage_token}")
    view = await env.service.view(created.manage_token)
    assert view is not None
    assert view.baseline_price == Decimal(100)  # перша перевірка — база, без сповіщення
    assert not any("Ціна знизилась" in t for t in env.texts())

    env.provider._offers = [round_trip("weekend", 85, friday, friday + timedelta(days=2))]
    env.now = NOW + timedelta(hours=1)
    assert await env.service.check(created.id) == 1
    text = env.last()
    assert "виліт 09.11.2026 – 30.11.2026, 1–3 ноч., лише вихідні" in text
    assert "Дати: 13.11.2026 – 15.11.2026." in text
    assert "Ціна без урахування багажу" in text
    assert "на 15 EUR дешевше, ніж на початку стеження (100 EUR)" in text
    url = env.service.search_url(
        (await _alert(env, created.id)), Found(Decimal(85), date(2026, 11, 13), date(2026, 11, 15))
    )
    assert url.endswith("/?from=WAW&to=LIS&depart=2026-11-13&return=2026-11-15&bag=carry_on")

    # Ще −5% від сповіщеної ціни — менше за 10%: не нова істотна зміна.
    env.provider._offers = [round_trip("weekend", 80, friday, friday + timedelta(days=2))]
    env.now = NOW + timedelta(hours=30)
    assert await env.service.check(created.id) == 0


async def test_stay_and_trip_alerts_are_off_without_real_stays(env: Env) -> None:
    assert env.service.channels().kinds == ["flight", "flex"]
    with pytest.raises(AlertError, match="недоступний"):
        await env.create(kind="stay", origin=None, return_date=date(2026, 11, 12))
    with pytest.raises(AlertError, match="недоступний"):
        await env.create(kind="trip", return_date=date(2026, 11, 12))


async def _alert(env: Env, alert_id: str) -> Alert:
    async with env.sessionmaker() as session:
        alert = await session.get(Alert, alert_id)
    assert alert is not None
    return alert


async def test_pause_resume_edit_history_delete(env: Env) -> None:
    """11.3: призупинити, відновити, змінити умову й дати, історія, видалити."""
    created = await env.create(channel="email", email="me@example.com", threshold=80)
    await env.service.confirm_email(created.manage_token)
    token = created.manage_token

    paused = await env.service.pause(token)
    assert paused is not None
    assert paused.status == "paused"
    assert await env.service.check(created.id) == 0  # призупинена — не перевіряємо
    resumed = await env.service.resume(token)
    assert resumed is not None
    assert resumed.status == "active"

    edit = AlertEdit(departure_date=DEPART, adults=1, condition="below_price", threshold=90)
    updated = await env.service.update(token, edit)
    assert updated is not None
    assert updated.threshold == 90
    assert updated.last_notified_price == Decimal(88)  # умова змінилась — перевірили одразу
    with pytest.raises(AlertError, match="потрібна сума"):
        await env.service.update(token, AlertEdit(departure_date=DEPART, threshold=None))
    with pytest.raises(AlertError, match="минула"):
        await env.service.update(token, AlertEdit(departure_date=date(2026, 11, 1), threshold=90))

    history = await env.service.history(token)
    assert history is not None
    kinds = [e.kind for e in history]
    assert kinds[:3] == ["notified", "edited", "resumed"]
    assert "checked" not in kinds
    assert "paused" in kinds
    assert kinds[-1] == "created"
    assert history[1].detail == "threshold"

    assert await env.service.delete(token)
    assert await env.service.view(token) is None
    async with env.sessionmaker() as session:
        left = await session.scalar(select(AlertEvent.id).where(AlertEvent.alert_id == created.id))
    assert left is None
    env.created.remove(created.id)


async def test_check_all_reuses_searches_respects_budget_and_skips_fresh(env: Env) -> None:
    """11.4: однакові пошуки — один запит; ліміт запитів; свіжоперевірені — не повторюємо."""
    same = [await env.create(channel="email", email=f"r{i}@example.com") for i in range(3)]
    other = await env.create(channel="email", email="o@example.com", return_date=date(2026, 11, 12))
    async with env.sessionmaker() as session, session.begin():
        for a in [*same, other]:
            alert = await session.get(Alert, a.id)
            assert alert is not None
            alert.status = "active"
    env.service._settings = replace(env.service.settings, max_searches_per_run=1)
    env.service._redis = env.redis  # type: ignore[assignment]

    env.provider.queries.clear()
    await env.service.check_all()
    assert len(env.provider.queries) == 1  # три однакові — один пошук, четверта — пізніше
    checked = {a.id: (await _alert(env, a.id)).last_checked_at for a in [*same, other]}
    assert all(checked[a.id] is not None for a in same)
    assert checked[other.id] is None

    env.now = NOW + timedelta(hours=1)  # повторний запуск одразу — лише відкладена
    await env.service.check_all()
    assert len(env.provider.queries) == 2
    assert (await _alert(env, other.id)).last_checked_at is not None

    await env.redis.set("alerts:check_all", "1")  # інша перевірка ще йде
    env.now = NOW + timedelta(hours=10)
    assert await env.service.check_all() == 0
    assert len(env.provider.queries) == 2


async def test_owner_limit_and_horizon(env: Env) -> None:
    env.service._settings = replace(env.service.settings, max_active_per_owner=2)
    await env.create(channel="email", email="lim@example.com")
    await env.create(channel="email", email="lim@example.com")
    with pytest.raises(AlertError, match="забагато"):
        await env.create(channel="email", email="lim@example.com")
    with pytest.raises(AlertError, match="365"):
        await env.create(channel="email", email="far@example.com", departure_date=date(2027, 12, 1))


async def test_typical_price_needs_history(env: Env) -> None:
    typical = await env.create(condition="below_typical", threshold=None)
    await env.say(f"/start {typical.manage_token}", chat_id=43)

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
    assert "нижче типової для маршруту ціни 120 EUR" in env.last()


async def test_past_dates_expire_and_stop_works(env: Env) -> None:
    created = await env.create()
    other = await env.create()
    await env.say(f"/start {created.manage_token}")

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


async def test_new_subscription_dialog_in_bot(env: Env) -> None:
    await env.bot.setup()
    assert [c for c, _ in env.telegram.commands] == [c for c, _ in COMMANDS]

    await env.say("/new")
    assert "Звідки летимо" in env.last()
    await env.say("Варшава")  # кілька аеропортів — кнопки вибору
    assert "pick:origin:WAW" in env.callbacks()
    await env.press("pick:origin:WAW")
    await env.say("lis")  # точний код — без перепитувань
    assert "WAW → LIS" in env.last()
    await env.say("31.02")
    assert "Не зрозумів дату" in env.last()
    await env.say("10.11")
    await env.press("ow")
    assert "Коли повідомити" in env.last()
    await env.say("до 100 €")

    # Підписка активна одразу, перша перевірка — до підсумку: 88 ≤ 100.
    assert "Ціна знизилась" in env.texts()[-2]
    assert "Стежу за ціною" in env.last()
    assert "Зараз від <b>88 EUR</b>" in env.last()
    [alert] = await env.service.chat_alerts(42)
    assert (alert.origin, alert.destination, alert.departure_date) == ("WAW", "LIS", DEPART)
    assert (alert.return_date, alert.threshold, alert.status) == (None, 100, "active")


async def test_list_stop_snooze_and_threshold_buttons_are_chat_scoped(env: Env) -> None:
    created = await env.create(threshold=50)
    await env.say(f"/start {created.manage_token}")

    await env.say("/list")
    assert f"stop:{created.id}" in env.callbacks()

    await env.press(f"thr:{created.id}")
    await env.say("95")
    assert "Ціна знизилась" in env.texts()[-2]  # 88 ≤ 95 — перевірка одразу
    assert "Новий поріг: <b>95 EUR</b>" in env.last()

    await env.press(f"snooze:{created.id}")
    assert env.telegram.answered[-1][1] == "Тиша до 13.11"
    env.provider._offers = offers_for("stub", [70])
    env.now = NOW + timedelta(days=2)
    assert await env.service.check(created.id) == 0  # тиша

    await env.press(f"stop:{created.id}", chat_id=7)  # чужий чат — нічого
    assert env.telegram.answered[-1][1] == "Уже вимкнена"
    await env.press(f"stop:{created.id}")
    assert env.last() == "⏸ Підписку вимкнено."
    assert await env.service.chat_alerts(42) == []


async def test_link_account_and_polling_offset(env: Env) -> None:
    async with env.sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_tg"))
        await session.flush()  # спершу власник: токен посилається на нього (ключ, 0020)
        session.add(
            AuthToken(
                token_hash=token_hash("link-code-1234567890"),
                user_id=USER_ID,
                purpose="telegram_link",
                expires_at=NOW + timedelta(minutes=30),
            )
        )
    start = {"chat": {"id": 42}, "text": "/start link_link-code-1234567890"}
    env.telegram.updates = [
        {"update_id": 10, "message": start},
        {"update_id": 11, "message": {"chat": {"id": 42}, "text": "/help"}},
    ]

    assert await env.bot.poll() == 2

    assert "прив'язано до акаунта <b>@ittest_tg</b>" in env.texts()[0]
    async with env.sessionmaker() as session:
        user = await session.get(User, USER_ID)
    assert user is not None
    assert user.telegram_chat_id == 42
    assert int(env.redis.store["alerts:telegram:offset"]) == 12
    assert await env.bot.poll() == 0  # підтверджені оновлення — не вдруге
    # Підписка з чату, прив'язаного до акаунта, — в кабінеті.
    await env.say("/new")
    for answer in ("WAW", "LIS", "10.11"):
        await env.say(answer)
    await env.press("ow")
    await env.press("typ")
    [alert] = await env.service.chat_alerts(42)
    assert alert.user_id == USER_ID


def test_parsers() -> None:
    today = date(2026, 11, 6)
    assert parse_date("2026-12-05", today) == date(2026, 12, 5)
    assert parse_date("5.12.2026", today) == date(2026, 12, 5)
    assert parse_date("01.02", today) == date(2027, 2, 1)  # уже минуло цього року
    assert parse_date("завтра", today) is None
    assert (parse_amount("до 99,9 €"), parse_amount("0"), parse_amount("сто")) == (99, None, None)
