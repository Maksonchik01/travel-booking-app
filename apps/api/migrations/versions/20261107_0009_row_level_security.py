"""row level security on every table

Supabase відкриває таблиці схеми public через Data API (PostgREST) публічним ключем.
RLS без жодних політик закриває їх для ролей anon/authenticated; бекенд працює від
власника таблиць (postgres), тож його запитів це не змінює. Локально — те саме: власник
таблиць RLS обходить. Нова таблиця — RLS у її міграції (перевіряє test_row_level_security).

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-07 20:30:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ALL_TABLES = """
DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
        EXECUTE format('ALTER TABLE %I {action} ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;
"""


def upgrade() -> None:
    op.execute(ALL_TABLES.format(action="ENABLE"))


def downgrade() -> None:
    op.execute(ALL_TABLES.format(action="DISABLE"))
