"""alert direct only and min rating

Етап 6 розширення (ADR 0050): умови сповіщень «лише прямі» та «рейтинг житла від N з 10».

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-11 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alerts",
        sa.Column("direct_only", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column("alerts", sa.Column("min_rating", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f("ck_alerts_min_rating"), "alerts", "min_rating IS NULL OR min_rating BETWEEN 1 AND 10"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_alerts_min_rating"), "alerts", type_="check")
    op.drop_column("alerts", "min_rating")
    op.drop_column("alerts", "direct_only")
