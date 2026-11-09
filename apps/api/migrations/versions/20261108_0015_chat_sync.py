"""chat sync

Розмови з помічником в акаунті — лише за згодою (users.chat_sync, модуль 9c). Нова таблиця —
одразу з RLS.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-08 21:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("chat_sync", sa.Boolean(), server_default="false", nullable=False)
    )
    op.create_table(
        "chat_conversations",
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index(
        "ix_chat_conversations_user", "chat_conversations", ["user_id", "updated_at"], unique=False
    )
    op.execute("ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_chat_conversations_user", table_name="chat_conversations")
    op.drop_table("chat_conversations")
    op.drop_column("users", "chat_sync")
