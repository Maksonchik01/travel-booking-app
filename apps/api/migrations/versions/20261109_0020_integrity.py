"""integrity: foreign keys, checks, expiry indexes, Data API privileges

Модуль 16 (ADR 0033). Цілісність тепер тримає й сама БД, а не лише код сервісів:

- зовнішні ключі до `users` (ON DELETE CASCADE) — видалення акаунта прибирає все його;
  `alert_events` → `alerts` теж каскадом. Перед ключами видаляємо «сиріт» (рядки без власника):
  до них і так ніхто не мав доступу, а ключ без цього не створиться;
- CHECK на переліки (статуси, типи, канали, мови, валюти) і прості межі. Додаємо NOT VALID —
  нові записи перевіряються одразу; наявні перевіряємо окремо й, якщо щось не проходить, лишаємо
  NOT VALID з NOTICE: деплой не падає через старі дані, а test_db_integrity це покаже;
- індекси `expires_at` для чистки прострочених сесій і токенів (воркер);
- Supabase: ролям Data API (anon, authenticated) — жодних прав на таблиці й послідовності.
  RLS (0009) і так закриває рядки; це другий рубіж, якщо RLS колись вимкнуть. Локально ролей
  немає — блок нічого не робить.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-09 12:00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

USER_TABLES = (
    "alerts",
    "auth_tokens",
    "chat_conversations",
    "favorites",
    "saved_trips",
    "search_entries",
    "user_avatars",
    "user_sessions",
)

CHECKS = (
    ("outbound_clicks", "ck_outbound_clicks_kind", "kind IN ('flight', 'stay')"),
    ("price_history", "ck_price_history_kind", "kind IN ('offer', 'calendar_min')"),
    (
        "users",
        "ck_users_currency",
        "currency IS NULL OR currency IN ('EUR', 'USD', 'GBP', 'PLN')",
    ),
    ("users", "ck_users_locale", "locale IS NULL OR locale IN ('en', 'uk', 'ru')"),
    (
        "alerts",
        "ck_alerts_status",
        "status IN ('pending', 'active', 'paused', 'stopped', 'expired')",
    ),
    (
        "alerts",
        "ck_alerts_baggage",
        "baggage IN ('none', 'personal_item', 'carry_on', 'checked', 'checked_extra')",
    ),
    ("alerts", "ck_alerts_adults", "adults BETWEEN 1 AND 9"),
    ("alerts", "ck_alerts_kind", "kind IN ('flight', 'flex', 'stay', 'trip')"),
    ("alerts", "ck_alerts_threshold", "threshold IS NULL OR threshold > 0"),
    (
        "alerts",
        "ck_alerts_condition",
        "condition IN ('below_price', 'below_typical', 'drop_amount', 'drop_percent')",
    ),
    ("alerts", "ck_alerts_percent", "percent IS NULL OR percent BETWEEN 1 AND 90"),
    ("alerts", "ck_alerts_channel", "channel IN ('telegram', 'email')"),
    (
        "alerts",
        "ck_alerts_nights",
        "min_nights IS NULL OR max_nights IS NULL OR min_nights <= max_nights",
    ),
    (
        "auth_tokens",
        "ck_auth_tokens_purpose",
        "purpose IN ('verify_email', 'reset_password', 'telegram_link')",
    ),
    ("favorites", "ck_favorites_kind", "kind IN ('stay', 'flight', 'trip')"),
    ("saved_trips", "ck_saved_trips_status", "status IN ('draft', 'planned', 'archived')"),
    ("search_entries", "ck_search_entries_kind", "kind IN ('flights', 'stays', 'trip')"),
    (
        "alert_events",
        "ck_alert_events_kind",
        "kind IN ('created', 'confirmed', 'checked', 'notified', 'held', 'paused', 'resumed',"
        " 'edited', 'snoozed', 'threshold', 'stopped', 'expired')",
    ),
)

VALIDATE = """
DO $$
BEGIN
    ALTER TABLE {table} VALIDATE CONSTRAINT {name};
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'constraint {name} left NOT VALID: existing rows violate it';
END $$;
"""

DATA_API_PRIVILEGES = """
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
        BEGIN
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                REVOKE ALL ON TABLES FROM anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                REVOKE ALL ON SEQUENCES FROM anon, authenticated;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'default privileges unchanged: not allowed for this role';
        END;
    END IF;
END $$;
"""


def upgrade() -> None:
    # Сироти: рядки, чийого власника вже немає (ключ інакше не створиться).
    for table in USER_TABLES:
        op.execute(
            f"DELETE FROM {table} t WHERE t.user_id IS NOT NULL "  # noqa: S608 — константи
            "AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id)"
        )
    op.execute(
        "DELETE FROM alert_events e WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = e.alert_id)"
    )
    for table in USER_TABLES:
        op.create_foreign_key(
            op.f(f"fk_{table}_user_id_users"), table, "users", ["user_id"], ["id"], ondelete="CASCADE"
        )
    op.create_foreign_key(
        op.f("fk_alert_events_alert_id_alerts"),
        "alert_events",
        "alerts",
        ["alert_id"],
        ["id"],
        ondelete="CASCADE",
    )

    for table, name, rule in CHECKS:
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({rule}) NOT VALID")
        op.execute(VALIDATE.format(table=table, name=name))

    op.create_index(op.f("ix_user_sessions_expires_at"), "user_sessions", ["expires_at"])
    op.create_index(op.f("ix_auth_tokens_expires_at"), "auth_tokens", ["expires_at"])
    op.execute(DATA_API_PRIVILEGES)


def downgrade() -> None:
    op.drop_index(op.f("ix_auth_tokens_expires_at"), table_name="auth_tokens")
    op.drop_index(op.f("ix_user_sessions_expires_at"), table_name="user_sessions")
    for table, name, _ in reversed(CHECKS):
        op.drop_constraint(op.f(name), table, type_="check")
    op.drop_constraint(op.f("fk_alert_events_alert_id_alerts"), "alert_events", type_="foreignkey")
    for table in USER_TABLES:
        op.drop_constraint(op.f(f"fk_{table}_user_id_users"), table, type_="foreignkey")
