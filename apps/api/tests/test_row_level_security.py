"""Кожна таблиця — з RLS (Supabase Data API, міграція 0009). Маркер integration."""

import os

import pytest
import tickets_api.db.models  # noqa: F401 — регіструє таблиці в metadata
from sqlalchemy import text
from tickets_api.db.base import Base
from tickets_api.db.session import create_engine

pytestmark = pytest.mark.integration


async def test_every_table_has_row_level_security() -> None:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL не задано")
    engine = create_engine(url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity"
            )
        )
        without_rls = {r[0] for r in rows}
    await engine.dispose()

    assert without_rls.isdisjoint(Base.metadata.tables), (
        f"Таблиці без RLS: {sorted(without_rls & set(Base.metadata.tables))}. "
        "Додайте ALTER TABLE … ENABLE ROW LEVEL SECURITY у міграцію таблиці."
    )
