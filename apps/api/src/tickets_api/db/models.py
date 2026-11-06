from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Index, Integer, Numeric, String, func
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
    collected_at) унікальні.
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
            "collected_at",
            unique=True,
        ),
    )
