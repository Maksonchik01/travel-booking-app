"""alert kinds and conditions

Модуль 11a: типи підписок (маршрут, гнучкі дати, житло, поїздка), багаж, умови зниження
на суму / відсоток від ціни першої перевірки.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-08 22:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alerts", sa.Column("kind", sa.String(length=8), nullable=False, server_default="flight")
    )
    op.alter_column("alerts", "origin", existing_type=sa.String(length=3), nullable=True)
    op.add_column("alerts", sa.Column("departure_until", sa.Date(), nullable=True))
    op.add_column("alerts", sa.Column("min_nights", sa.Integer(), nullable=True))
    op.add_column("alerts", sa.Column("max_nights", sa.Integer(), nullable=True))
    op.add_column(
        "alerts", sa.Column("weekends", sa.Boolean(), nullable=False, server_default="false")
    )
    op.add_column(
        "alerts", sa.Column("baggage", sa.String(length=16), nullable=False, server_default="none")
    )
    op.add_column("alerts", sa.Column("stay_key", sa.String(length=110), nullable=True))
    op.add_column("alerts", sa.Column("percent", sa.Integer(), nullable=True))
    op.add_column("alerts", sa.Column("baseline_price", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    for name in (
        "baseline_price",
        "percent",
        "stay_key",
        "baggage",
        "weekends",
        "max_nights",
        "min_nights",
        "departure_until",
    ):
        op.drop_column("alerts", name)
    op.execute("DELETE FROM alerts WHERE origin IS NULL")
    op.alter_column("alerts", "origin", existing_type=sa.String(length=3), nullable=False)
    op.drop_column("alerts", "kind")
