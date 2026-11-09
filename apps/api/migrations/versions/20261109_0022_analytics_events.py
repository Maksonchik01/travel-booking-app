"""analytics events

Модуль 19: анонімні події використання (назва + мітки, без людини, сесії й IP), 90 днів.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-09 21:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENT_NAMES = (
    "search_started",
    "search_succeeded",
    "search_empty",
    "search_failed",
    "filters_applied",
    "offer_opened",
    "compare_opened",
    "outbound",
    "favorite_added",
    "trip_saved",
    "cheaper_requested",
    "ai_optimize",
    "alert_created",
    "ai_to_planner",
)


def upgrade() -> None:
    names = ", ".join(f"'{n}'" for n in EVENT_NAMES)
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=32), nullable=False),
        sa.Column("props", sa.String(length=300), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(f"name IN ({names})", name=op.f("ck_analytics_events_name")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_analytics_events")),
    )
    op.create_index(
        "ix_analytics_events_name_created", "analytics_events", ["name", "created_at"]
    )
    op.create_index("ix_analytics_events_created_at", "analytics_events", ["created_at"])
    op.execute("ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_analytics_events_created_at", table_name="analytics_events")
    op.drop_index("ix_analytics_events_name_created", table_name="analytics_events")
    op.drop_table("analytics_events")
