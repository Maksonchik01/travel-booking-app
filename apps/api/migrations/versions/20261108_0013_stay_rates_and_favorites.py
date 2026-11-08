"""stay rates in price history, favorites

Тарифи продавців житла (модуль 7) пишуться в stay_price_history з продавцем і номером —
вони входять в унікальний ключ. Нова таблиця favorites одразу з RLS (як 0009).

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-08 15:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_KEY = ["source", "stay_id", "check_in", "check_out", "guests", "collected_at"]
NEW_KEY = ["source", "stay_id", "check_in", "check_out", "guests", "seller", "room", "collected_at"]


def upgrade() -> None:
    op.add_column(
        "stay_price_history",
        sa.Column("seller", sa.String(length=64), server_default="", nullable=False),
    )
    op.add_column(
        "stay_price_history",
        sa.Column("room", sa.String(length=120), server_default="", nullable=False),
    )
    op.drop_index("uq_stay_price_history_observation", table_name="stay_price_history")
    op.create_index(
        "uq_stay_price_history_observation", "stay_price_history", NEW_KEY, unique=True
    )

    op.create_table(
        "favorites",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("item_key", sa.String(length=200), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_favorites_item", "favorites", ["user_id", "kind", "item_key"], unique=True)
    op.create_index("ix_favorites_user", "favorites", ["user_id", "created_at"], unique=False)
    op.execute("ALTER TABLE favorites ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_favorites_user", table_name="favorites")
    op.drop_index("uq_favorites_item", table_name="favorites")
    op.drop_table("favorites")
    op.drop_index("uq_stay_price_history_observation", table_name="stay_price_history")
    # Тарифи продавців мали б дублі за старим ключем — прибираємо їх перед поверненням індексу.
    op.execute("DELETE FROM stay_price_history WHERE seller <> ''")
    op.create_index(
        "uq_stay_price_history_observation", "stay_price_history", OLD_KEY, unique=True
    )
    op.drop_column("stay_price_history", "room")
    op.drop_column("stay_price_history", "seller")
