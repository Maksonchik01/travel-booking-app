"""Цілісність БД (модуль 16, міграція 0020) проти Postgres — маркер integration.

Ключі й CHECK у БД збігаються з моделями (а моделі беруть переліки з тих самих Literal, що й
Pydantic); видалення акаунта каскадом прибирає все його; прострочене чиститься; однакова
підписка власника не дублюється; Data API не має прав на таблиці.
"""

import os
import re
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta

import pytest
import tickets_api.db.models  # noqa: F401 — регіструє таблиці в metadata
from flight_fakes import StubProvider, offers_for
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from tickets_api.db.base import Base
from tickets_api.db.models import (
    Alert,
    AlertEvent,
    AuthToken,
    ChatConversation,
    Favorite,
    SavedTrip,
    SearchEntry,
    User,
    UserAvatar,
    UserSession,
)
from tickets_api.db.session import create_engine, create_sessionmaker
from tickets_api.domain.alerts import AlertCreate
from tickets_api.notifications.mail import MockMailer
from tickets_api.notifications.telegram import MockTelegram
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.alerts import AlertService, AlertSettings
from tickets_api.services.flight_search import FlightSearchService
from tickets_api.services.maintenance import prune_expired

pytestmark = pytest.mark.integration

NOW = datetime(2026, 11, 9, 12, tzinfo=UTC)
USER_ID = "ittest-integrity"


def constraint_name(c: CheckConstraint | ForeignKeyConstraint, table: str) -> str:
    """Ім'я, яке дає NAMING_CONVENTION (db/base.py)."""
    if isinstance(c, CheckConstraint):
        return str(c.name)  # угоду застосовано ще при оголошенні таблиці
    element = c.elements[0]
    return f"fk_{table}_{element.parent.name}_{element.column.table.name}"


@pytest.fixture
async def sessionmaker() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    maker = create_sessionmaker(engine)

    async def cleanup() -> None:
        async with maker() as session, session.begin():
            await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": USER_ID})

    await cleanup()
    yield maker
    await cleanup()
    await engine.dispose()


async def test_constraints_in_db_match_models(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT conname, contype, convalidated, pg_get_constraintdef(oid) "
                    "FROM pg_constraint WHERE contype IN ('c', 'f') AND conname LIKE ANY "
                    "(ARRAY['ck\\_%', 'fk\\_%'])"
                )
            )
        ).all()
    in_db = {name: (kind, valid, definition) for name, kind, valid, definition in rows}

    for table in Base.metadata.sorted_tables:
        for fk in table.constraints:
            if isinstance(fk, ForeignKeyConstraint):
                name = constraint_name(fk, table.name)
                assert name in in_db, f"немає ключа {name}: потрібна міграція"
                assert "ON DELETE CASCADE" in in_db[name][2]
        for c in table.constraints:
            if not isinstance(c, CheckConstraint):
                continue
            name = constraint_name(c, table.name)
            assert name in in_db, f"немає CHECK {name}: потрібна міграція"
            assert in_db[name][1], f"{name} лишився NOT VALID — у БД є рядки, що його порушують"
            # Кожне значення переліку з моделі (Literal) — і в БД.
            for value in re.findall(r"'([^']*)'", str(c.sqltext)):
                assert f"'{value}'" in in_db[name][2], f"{name}: у БД немає {value!r}"


async def test_deleting_user_cascades_to_everything_they_own(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_integrity"))
        await session.flush()
        session.add_all(
            [
                UserSession(token_hash="h" * 64, user_id=USER_ID, expires_at=NOW),
                AuthToken(
                    token_hash="t" * 64, user_id=USER_ID, purpose="verify_email", expires_at=NOW
                ),
                SearchEntry(id="se", user_id=USER_ID, kind="flights", params="a=1", title="t"),
                Favorite(id="fv", user_id=USER_ID, kind="stay", item_key="k", data="{}"),
                SavedTrip(id="st", user_id=USER_ID, title="t", query="{}", snapshot="{}"),
                ChatConversation(user_id=USER_ID, id="c1", data="{}", updated_at=NOW),
                UserAvatar(user_id=USER_ID, content_type="image/png", data=b"x", updated_at=NOW),
                _alert("ittest-al", user_id=USER_ID),
            ]
        )
        await session.flush()
        session.add(AlertEvent(alert_id="ittest-al", kind="created"))

    async with sessionmaker() as session, session.begin():
        await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": USER_ID})

    async with sessionmaker() as session:
        for model in (
            UserSession,
            AuthToken,
            SearchEntry,
            Favorite,
            SavedTrip,
            ChatConversation,
            UserAvatar,
            Alert,
        ):
            left = await session.scalar(select(model).where(model.user_id == USER_ID))
            assert left is None, model.__tablename__
        event = await session.scalar(select(AlertEvent).where(AlertEvent.alert_id == "ittest-al"))
        assert event is None


async def test_db_rejects_unknown_values_and_orphans(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_integrity"))
    bad = SavedTrip(id="bad", user_id=USER_ID, title="t", query="{}", snapshot="{}", status="x")
    with pytest.raises(IntegrityError, match="ck_saved_trips_status"):
        async with sessionmaker() as session, session.begin():
            session.add(bad)
    with pytest.raises(IntegrityError, match="fk_favorites_user_id_users"):
        async with sessionmaker() as session, session.begin():
            session.add(Favorite(id="orph", user_id="nobody", kind="stay", item_key="k", data="{}"))


async def test_prune_removes_only_expired(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    async with sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_integrity"))
        await session.flush()
        session.add_all(
            [
                UserSession(token_hash="old" + "0" * 61, user_id=USER_ID, expires_at=NOW),
                UserSession(
                    token_hash="new" + "0" * 61,
                    user_id=USER_ID,
                    expires_at=NOW + timedelta(days=1),
                ),
                AuthToken(
                    token_hash="tok" + "0" * 61,
                    user_id=USER_ID,
                    purpose="reset_password",
                    expires_at=NOW - timedelta(minutes=1),
                ),
            ]
        )

    removed = await prune_expired(sessionmaker, clock=lambda: NOW + timedelta(seconds=1))

    assert removed >= 2
    async with sessionmaker() as session:
        sessions = (
            await session.scalars(
                select(UserSession.token_hash).where(UserSession.user_id == USER_ID)
            )
        ).all()
    assert sessions == ["new" + "0" * 61]


async def test_owner_gets_existing_alert_instead_of_duplicate(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session, session.begin():
        session.add(User(id=USER_ID, username="ittest_integrity"))
    service = AlertService(
        sessionmaker,
        search=FlightSearchService(
            [StubProvider("t", offers=offers_for("t", [100]))],
            timeout_s=1,
            scoring_config=default_scoring_config(),
        ),
        telegram=MockTelegram(),
        mailer=MockMailer(),
        settings=AlertSettings(
            public_web_url="https://tickets.example",
            bot_username=None,
            min_hours_between_notifications=24,
        ),
        clock=lambda: NOW,
    )
    body = AlertCreate(
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 12, 5),
        threshold=150,
        channel="email",
        email="me@example.com",
    )

    first = await service.create(body, user_id=USER_ID)
    again = await service.create(body, user_id=USER_ID)
    other = await service.create(body.model_copy(update={"threshold": 120}), user_id=USER_ID)
    anonymous = await service.create(body)

    assert again.existing
    assert again.id == first.id
    assert not other.existing
    assert other.id != first.id
    # Без акаунта наявний токен не віддаємо: хто знає email, не отримає чужу підписку.
    assert not anonymous.existing
    assert anonymous.manage_token != first.manage_token
    async with sessionmaker() as session, session.begin():
        await session.execute(text("DELETE FROM alerts WHERE id = :id"), {"id": anonymous.id})


async def test_data_api_roles_have_no_table_privileges(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session:
        roles = (
            await session.scalars(
                text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")
            )
        ).all()
        if not roles:
            pytest.skip("ролей Supabase Data API тут немає (локальний Postgres)")
        grants = (
            await session.execute(
                text(
                    "SELECT grantee, table_name FROM information_schema.role_table_grants "
                    "WHERE table_schema = current_schema() AND grantee IN ('anon', 'authenticated')"
                )
            )
        ).all()
    assert grants == []


def _alert(alert_id: str, *, user_id: str | None = None) -> Alert:
    return Alert(
        id=alert_id,
        token=alert_id + "-token",
        origin="WAW",
        destination="LIS",
        departure_date=date(2026, 12, 5),
        adults=1,
        condition="below_price",
        threshold=100,
        currency="EUR",
        channel="email",
        email="me@example.com",
        user_id=user_id,
        status="active",
    )
