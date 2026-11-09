"""Налаштування сповіщень акаунта (модуль 10c) і рішення «надсилати зараз чи ні». Без I/O.

Діють на підписки, створені з акаунтом (`alerts.user_id`); анонімні підписки — як раніше.
Глобальні правила (лише нижча ціна, не частіше за ALERT_MIN_HOURS) лишаються нижньою межею.
"""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, Field

from tickets_api.domain.alerts import AlertCondition
from tickets_api.domain.flights import _StrictInput

IntervalHours = Literal[24, 72, 168]
DropPercent = Literal[0, 3, 5, 10]
HoldReason = Literal["channel_off", "category_off", "quiet_hours", "too_soon", "small_drop"]


def _known_zone(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("unknown time zone") from exc
    return value


class NotifyPrefs(_StrictInput):
    email: bool = True
    telegram: bool = True
    min_interval_hours: IntervalHours = 24
    """Не частіше за раз на стільки годин для однієї підписки."""
    min_drop_percent: DropPercent = 0
    """Наступне сповіщення — лише якщо ціна впала щонайменше на стільки від попереднього."""
    quiet_start: int | None = Field(default=None, ge=0, le=23)
    quiet_end: int | None = Field(default=None, ge=0, le=23)
    """Тихі години [start, end) за місцевим часом; через північ — напр. 22 → 8."""
    timezone: Annotated[str | None, AfterValidator(_known_zone)] = Field(
        default=None, max_length=64
    )
    """Пояс для тихих годин (IANA, береться з браузера); без нього — UTC."""
    muted: list[AlertCondition] = Field(default_factory=list, max_length=2)
    """Вимкнені категорії: below_price (нижче порогу), below_typical (вигідна ціна)."""


def in_quiet_hours(prefs: NotifyPrefs, now: datetime) -> bool:
    start, end = prefs.quiet_start, prefs.quiet_end
    if start is None or end is None or start == end:
        return False
    hour = now.astimezone(ZoneInfo(prefs.timezone or "UTC")).hour
    return start <= hour < end if start < end else hour >= start or hour < end


def hold_reason(
    prefs: NotifyPrefs,
    *,
    channel: str,
    condition: str,
    best: Decimal,
    previous: Decimal | None,
    hours_since_last: float | None,
    now: datetime,
) -> HoldReason | None:
    """Чому НЕ надсилати сповіщення зараз (None — надсилати). Умову ціни вже перевірено."""
    if (channel == "email" and not prefs.email) or (channel == "telegram" and not prefs.telegram):
        return "channel_off"
    if condition in prefs.muted:
        return "category_off"
    if hours_since_last is not None and hours_since_last < prefs.min_interval_hours:
        return "too_soon"
    drop = Decimal(100 - prefs.min_drop_percent) / 100
    if previous is not None and prefs.min_drop_percent and best > previous * drop:
        return "small_drop"
    if in_quiet_hours(prefs, now):
        return "quiet_hours"
    return None


def notify_prefs(raw: str | None) -> NotifyPrefs:
    """Збережене (JSON); порожнє чи невалідне після зміни схеми — значення за замовчуванням."""
    if not raw:
        return NotifyPrefs()
    try:
        return NotifyPrefs.model_validate_json(raw)
    except ValueError:
        return NotifyPrefs()
