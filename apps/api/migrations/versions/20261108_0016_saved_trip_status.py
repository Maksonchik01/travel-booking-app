"""saved trip status

Статуси збережених поїздок (модуль 10a): draft / planned / archived.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-08 23:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "saved_trips",
        sa.Column("status", sa.String(length=16), server_default="draft", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("saved_trips", "status")
