"""profile preferences and avatar

Профіль (модуль 10b): мова, валюта, країна, домашній і улюблені аеропорти, фото Google;
власне фото — окрема таблиця з RLS.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-08 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = (
    ("locale", 2),
    ("currency", 3),
    ("country", 2),
    ("home_airport", 3),
    ("favorite_airports", 40),
    ("google_picture", 500),
)


def upgrade() -> None:
    for name, length in COLUMNS:
        op.add_column("users", sa.Column(name, sa.String(length=length), nullable=True))
    op.add_column("users", sa.Column("search_prefs", sa.Text(), nullable=True))
    op.create_table(
        "user_avatars",
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("content_type", sa.String(length=32), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.execute("ALTER TABLE user_avatars ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("user_avatars")
    op.drop_column("users", "search_prefs")
    for name, _ in reversed(COLUMNS):
        op.drop_column("users", name)
