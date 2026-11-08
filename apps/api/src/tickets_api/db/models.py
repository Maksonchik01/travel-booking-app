from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Index, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tickets_api.db.base import Base


class PriceObservation(Base):
    """Історія цін: кожна ціна, яку ми отримали від провайдера (пошук або календар).

    Одна й та сама ціна з кешу не дублюється: (source, observation_key, collected_at)
    унікальні, а при повторі з кешу collected_at той самий.
    """

    __tablename__ = "price_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    origin: Mapped[str] = mapped_column(String(3))
    """Код із запиту (місто чи аеропорт) — ключ маршруту для статистики цін."""
    destination: Mapped[str] = mapped_column(String(3))
    departure_date: Mapped[date] = mapped_column(Date)
    return_date: Mapped[date | None] = mapped_column(Date)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3))
    stops: Mapped[int | None]
    source: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))
    """offer — повна пропозиція з пошуку; calendar_min — мінімум дня з календаря."""
    party: Mapped[str] = mapped_column(String(16), server_default="1a0c0l0s")
    """Склад пасажирів, за який ця ціна (Passengers.code). Статистика порівнює лише однакові."""
    cabin: Mapped[str] = mapped_column(String(16), server_default="economy")
    observation_key: Mapped[str] = mapped_column(String(64))
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    found_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    found_on: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_price_history_route_date", "origin", "destination", "departure_date"),
        Index(
            "uq_price_history_observation",
            "source",
            "observation_key",
            "collected_at",
            unique=True,
        ),
    )


class LLMUsage(Base):
    """Облік кожного виклику моделі: токени й вартість. Тексту запитів тут немає (GDPR)."""

    __tablename__ = "llm_usage"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(String(32))
    """Один запит користувача (розбір чи пояснення) — кілька викликів моделі."""
    purpose: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    """ok | error."""
    input_cache_hit_tokens: Mapped[int] = mapped_column(Integer, default=0)
    input_cache_miss_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    """None — моделі немає в прайсі."""
    latency_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_llm_usage_created_at", "created_at"),)


class StayPriceObservation(Base):
    """Історія цін житла: кожна ціна, яку ми отримали від провайдера.

    Повтор тієї ж ціни з кешу не дублюється: (source, stay_id, check_in, check_out, guests,
    seller, room, collected_at) унікальні. Рядки пошуку — з порожніми `seller`/`room`;
    тарифи продавців (модуль 7) — з продавцем і номером, `kind` = "rate".
    """

    __tablename__ = "stay_price_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    city: Mapped[str] = mapped_column(String(3))
    """Код із запиту — ключ для статистики цін міста."""
    check_in: Mapped[date] = mapped_column(Date)
    check_out: Mapped[date] = mapped_column(Date)
    guests: Mapped[int] = mapped_column(Integer)
    stay_id: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))
    price_per_night: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    total_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3))
    source: Mapped[str] = mapped_column(String(32))
    seller: Mapped[str] = mapped_column(String(64), server_default="")
    room: Mapped[str] = mapped_column(String(120), server_default="")
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_stay_price_history_city_dates", "city", "check_in", "check_out"),
        Index(
            "uq_stay_price_history_observation",
            "source",
            "stay_id",
            "check_in",
            "check_out",
            "guests",
            "seller",
            "room",
            "collected_at",
            unique=True,
        ),
    )


class Alert(Base):
    """Підписка на ціну маршруту. Контакт — лише Telegram chat id або email (GDPR-мінімум).

    `token` — секрет у посиланні керування (і в /start бота); дає доступ лише до цієї підписки.
    """

    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    origin: Mapped[str] = mapped_column(String(3))
    destination: Mapped[str] = mapped_column(String(3))
    departure_date: Mapped[date] = mapped_column(Date)
    return_date: Mapped[date | None] = mapped_column(Date)
    adults: Mapped[int] = mapped_column(Integer, default=1)
    condition: Mapped[str] = mapped_column(String(16))
    threshold: Mapped[int | None] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))
    channel: Mapped[str] = mapped_column(String(16))
    email: Mapped[str | None] = mapped_column(String(254))
    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger)
    user_id: Mapped[str | None] = mapped_column(String(32), index=True)
    """Власник, якщо підписку створено під час входу (тоді видно в кабінеті)."""
    status: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    last_notified_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    snoozed_until: Mapped[date | None] = mapped_column(Date)
    """«Тиша» з бота: до цієї дати перевіряємо, але не сповіщаємо."""

    __table_args__ = (
        Index("ix_alerts_status", "status"),
        Index("ix_alerts_telegram_chat", "telegram_chat_id"),
    )


class AlertEvent(Base):
    """Журнал підписки: підтвердження, перевірки, сповіщення, відписка (без текстів листів)."""

    __tablename__ = "alert_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    alert_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    detail: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    """Акаунт. Мінімум даних (GDPR): логін, ім'я, email (необов'язковий), способи входу.

    Пароль — лише хеш scrypt; Google — лише незмінний `sub`; Telegram — chat id.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    username: Mapped[str] = mapped_column(String(30), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(200))
    first_name: Mapped[str | None] = mapped_column(String(60))
    last_name: Mapped[str | None] = mapped_column(String(60))
    email: Mapped[str | None] = mapped_column(String(254), unique=True)
    """Лише підтверджена адреса; нова чекає підтвердження в auth_tokens."""
    google_sub: Mapped[str | None] = mapped_column(String(64), unique=True)
    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    flight_filters: Mapped[str | None] = mapped_column(String(1000))
    """Збережені фільтри пошуку перельотів: рядок URL (`stops=1&dep=morning`), відомі ключі."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserSession(Base):
    """Сесія входу. У БД — лише SHA-256 токена; сам токен — у httpOnly-cookie браузера."""

    __tablename__ = "user_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuthToken(Base):
    """Одноразові токени з листів: підтвердження email і скидання пароля (лише хеш)."""

    __tablename__ = "auth_tokens"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    purpose: Mapped[str] = mapped_column(String(16))
    """verify_email — нова адреса в `email`; reset_password."""
    email: Mapped[str | None] = mapped_column(String(254))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SearchEntry(Base):
    """Історія пошуків і збережені пошуки користувача (`saved` — у «Збереженому»).

    `params` — рядок URL сторінки результатів (from=WAW&to=LIS&…): відкрити знову = перейти.
    """

    __tablename__ = "search_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))
    """flights / stays / trip."""
    params: Mapped[str] = mapped_column(String(500))
    title: Mapped[str] = mapped_column(String(120))
    saved: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_search_entries_user", "user_id", "saved", "updated_at"),)


class Favorite(Base):
    """«В обране» (модуль 7): структурований знімок об'єкта й умов пошуку, а не лише посилання.

    Ціна в знімку — на момент збереження; UI так її й підписує. (user_id, kind, item_key)
    унікальні — повторне «В обране» нічого не дублює.
    """

    __tablename__ = "favorites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))
    """stay (далі — й інші типи)."""
    item_key: Mapped[str] = mapped_column(String(200))
    data: Mapped[str] = mapped_column(Text)
    """JSON знімка (FavoriteStay), перевірений моделлю перед записом."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("uq_favorites_item", "user_id", "kind", "item_key", unique=True),
        Index("ix_favorites_user", "user_id", "created_at"),
    )


class SavedTrip(Base):
    """Збережена поїздка (модуль 8c): запит з обраним рейсом і житлом + знімок цін на момент
    збереження (JSON, перевірений моделями `SavedTripBody`). Ціни знімка — історичні."""

    __tablename__ = "saved_trips"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(120))
    query: Mapped[str] = mapped_column(Text)
    snapshot: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_saved_trips_user", "user_id", "updated_at"),)


class OutboundClick(Base):
    """Перехід на сайт партнера («Забронювати»). Лише що й куди — без користувача й IP (GDPR)."""

    __tablename__ = "outbound_clicks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(8))
    """flight / stay."""
    source: Mapped[str] = mapped_column(String(32))
    """Провайдер пропозиції (serpapi, travelpayouts…)."""
    host: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_outbound_clicks_created_at", "created_at"),)
