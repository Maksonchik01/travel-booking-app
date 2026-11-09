"""alert locale

Модуль 18.1: мова листів і повідомлень підписки. Наявні підписки — мовою акаунта власника,
якщо вона відома; інші лишаються NULL (тексти за замовчуванням — українською, як і досі).

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-09 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alerts", sa.Column("locale", sa.String(length=2), nullable=True))
    op.execute(
        "UPDATE alerts SET locale = u.locale FROM users u "
        "WHERE alerts.user_id = u.id AND u.locale IS NOT NULL"
    )
    op.create_check_constraint(
        op.f("ck_alerts_locale"), "alerts", "locale IS NULL OR locale IN ('en', 'uk', 'ru')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_alerts_locale"), "alerts", type_="check")
    op.drop_column("alerts", "locale")
