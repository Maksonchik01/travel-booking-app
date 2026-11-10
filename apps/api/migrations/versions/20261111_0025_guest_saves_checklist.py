"""destination favorites, explore searches, trip checklist

Етап 7 розширення (ADR 0051): обране «напрямок» (Explore), пошуки Explore в історії й збереженому,
чекліст збереженої поїздки.

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-11 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHECKS = (
    (
        "favorites",
        "ck_favorites_kind",
        "kind IN ('stay', 'flight', 'trip', 'destination')",
        "kind IN ('stay', 'flight', 'trip')",
    ),
    (
        "search_entries",
        "ck_search_entries_kind",
        "kind IN ('flights', 'stays', 'trip', 'explore')",
        "kind IN ('flights', 'stays', 'trip')",
    ),
)


def upgrade() -> None:
    for table, name, rule, _ in CHECKS:
        op.drop_constraint(op.f(name), table, type_="check")
        op.create_check_constraint(op.f(name), table, rule)
    op.add_column("saved_trips", sa.Column("checklist", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("saved_trips", "checklist")
    op.execute("DELETE FROM favorites WHERE kind = 'destination'")
    op.execute("DELETE FROM search_entries WHERE kind = 'explore'")
    for table, name, _, rule in CHECKS:
        op.drop_constraint(op.f(name), table, type_="check")
        op.create_check_constraint(op.f(name), table, rule)
