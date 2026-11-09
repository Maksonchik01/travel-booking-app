"""saved trip share token

Модуль 20.2: публічне посилання на збережену поїздку. За замовчуванням NULL — приватна.

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-10 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("saved_trips", sa.Column("share_token", sa.String(length=32), nullable=True))
    op.create_unique_constraint(
        op.f("uq_saved_trips_share_token"), "saved_trips", ["share_token"]
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_saved_trips_share_token"), "saved_trips", type_="unique")
    op.drop_column("saved_trips", "share_token")
