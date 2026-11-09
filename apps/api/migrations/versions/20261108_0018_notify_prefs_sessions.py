"""notification preferences and session devices

Модуль 10c: налаштування сповіщень акаунта; пристрій і остання активність сесій.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-08 21:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("notify_prefs", sa.Text(), nullable=True))
    op.add_column("user_sessions", sa.Column("device", sa.String(length=60), nullable=True))
    op.add_column(
        "user_sessions",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_sessions", "last_seen_at")
    op.drop_column("user_sessions", "device")
    op.drop_column("users", "notify_prefs")
