"""saved trips

Збережені поїздки (модуль 8c): запит з вибором + знімок цін. Нова таблиця — одразу з RLS.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-08 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "saved_trips",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("snapshot", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_saved_trips_user", "saved_trips", ["user_id", "updated_at"], unique=False)
    op.execute("ALTER TABLE saved_trips ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_saved_trips_user", table_name="saved_trips")
    op.drop_table("saved_trips")
