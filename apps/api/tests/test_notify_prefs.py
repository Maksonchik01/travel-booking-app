from datetime import UTC, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError
from tickets_api.domain.notify import NotifyPrefs, hold_reason, in_quiet_hours, notify_prefs

NOON = datetime(2026, 11, 8, 12, tzinfo=UTC)


def reason(prefs: NotifyPrefs, **kw: object) -> str | None:
    args: dict[str, object] = {
        "channel": "telegram",
        "condition": "below_price",
        "best": Decimal(90),
        "previous": None,
        "hours_since_last": None,
        "now": NOON,
    }
    args.update(kw)
    return hold_reason(prefs, **args)  # type: ignore[arg-type]


def test_defaults_send_everything() -> None:
    assert reason(NotifyPrefs()) is None
    assert reason(NotifyPrefs(), previous=Decimal(100), hours_since_last=30) is None


def test_channel_category_frequency_and_drop() -> None:
    assert reason(NotifyPrefs(telegram=False)) == "channel_off"
    assert reason(NotifyPrefs(email=False)) is None  # підписка в Telegram
    assert reason(NotifyPrefs(email=False), channel="email") == "channel_off"
    assert reason(NotifyPrefs(muted=["below_typical"]), condition="below_typical") == (
        "category_off"
    )
    assert reason(NotifyPrefs(min_interval_hours=72), hours_since_last=48) == "too_soon"
    assert reason(NotifyPrefs(min_interval_hours=72), hours_since_last=73) is None
    drop = NotifyPrefs(min_drop_percent=10)
    assert reason(drop, previous=Decimal(99)) == "small_drop"
    assert reason(drop, previous=Decimal(100)) is None  # рівно −10%


def test_quiet_hours_local_time_and_over_midnight() -> None:
    night = NotifyPrefs(quiet_start=22, quiet_end=8, timezone="Europe/Kyiv")
    assert in_quiet_hours(night, datetime(2026, 11, 8, 21, tzinfo=UTC))  # 23:00 Київ
    assert in_quiet_hours(night, datetime(2026, 11, 8, 5, tzinfo=UTC))  # 07:00
    assert not in_quiet_hours(night, datetime(2026, 11, 8, 6, tzinfo=UTC))  # 08:00
    assert not in_quiet_hours(NotifyPrefs(quiet_start=22), NOON)  # без кінця — вимкнено
    assert reason(NotifyPrefs(quiet_start=11, quiet_end=13)) == "quiet_hours"  # UTC


def test_validation_and_stored_fallback() -> None:
    with pytest.raises(ValidationError):
        NotifyPrefs(timezone="Mars/Olympus")
    with pytest.raises(ValidationError):
        NotifyPrefs.model_validate({"min_interval_hours": 1})
    assert notify_prefs('{"min_drop_percent": 7}') == NotifyPrefs()
    assert notify_prefs('{"email": false}').email is False
