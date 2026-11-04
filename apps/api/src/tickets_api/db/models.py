from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Index, Numeric, String, func
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
