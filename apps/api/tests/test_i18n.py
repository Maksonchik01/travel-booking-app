"""Модуль 18.1: тексти, які формує API (сповіщення, бот, листи, дані для ШІ), — трьома мовами."""

import re
from datetime import date, timedelta
from decimal import Decimal
from string import Formatter
from typing import Any

import pytest
from tickets_api.ai.explainer import TITLES, age_text, duration_text
from tickets_api.db.models import Alert
from tickets_api.i18n import (
    LOCALES,
    as_locale,
    catalog,
    current_locale,
    plural_form,
    t,
    telegram_locale,
    use_locale,
)
from tickets_api.services.alerts import (
    Found,
    condition_text,
    confirm_email_text,
    party_text,
    price_drop_text,
    route_text,
)

PLURAL = {"one", "few", "many", "other"}


def leaves(node: Any, prefix: str = "") -> dict[str, Any]:
    """Ключ → рядок або множина (dict з формами — один «лист»)."""
    if isinstance(node, dict) and not set(node) <= PLURAL:
        out: dict[str, Any] = {}
        for key, value in node.items():
            out |= leaves(value, f"{prefix}{key}.")
        return out
    return {prefix.rstrip("."): node}


def placeholders(value: Any) -> set[str]:
    texts = value.values() if isinstance(value, dict) else [value]
    return {name for text in texts for _, name, _, _ in Formatter().parse(text) if name}


def test_catalogs_have_the_same_keys_and_placeholders() -> None:
    base = leaves(catalog("uk"))
    for locale in LOCALES:
        other = leaves(catalog(locale))
        assert set(other) == set(base), locale
        for key, value in base.items():
            assert placeholders(other[key]) == placeholders(value), f"{locale}: {key}"


def test_plural_forms_are_complete() -> None:
    for locale in LOCALES:
        for key, value in leaves(catalog(locale)).items():
            if isinstance(value, dict):
                needed = {"one", "other"} if locale == "en" else {"one", "few", "many"}
                assert needed <= set(value), f"{locale}: {key}"


@pytest.mark.parametrize(
    ("locale", "n", "form"),
    [
        ("uk", 1, "one"),
        ("uk", 3, "few"),
        ("uk", 5, "many"),
        ("uk", 11, "many"),
        ("uk", 21, "one"),
        ("uk", 22, "few"),
        ("ru", 14, "many"),
        ("en", 1, "one"),
        ("en", 2, "other"),
    ],
)
def test_plural_rules(locale: Any, n: int, form: str) -> None:
    assert plural_form(locale, n) == form


def test_locale_detection() -> None:
    assert as_locale("uk-UA") == "uk"
    assert as_locale("pl") is None
    assert telegram_locale("ru") == "ru"
    assert telegram_locale("de") == "en"  # інша відома мова — англійська
    assert telegram_locale(None) is None
    with use_locale("en"):
        assert current_locale() == "en"
    assert current_locale() == "uk"  # без контексту — за замовчуванням


def alert(**fields: Any) -> Alert:
    data: dict[str, Any] = {
        "id": "a1",
        "token": "tok",
        "kind": "flight",
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": date(2026, 12, 5),
        "return_date": date(2026, 12, 9),
        "adults": 2,
        "baggage": "none",
        "condition": "below_price",
        "threshold": 200,
        "currency": "EUR",
        "channel": "email",
        "weekends": False,
    }
    return Alert(**(data | fields))


@pytest.mark.parametrize(
    ("locale", "party", "condition", "subject_word"),
    [
        ("uk", "за 2 дорослих", "ціна до 200 EUR за 2 дорослих", "Ціна знизилась"),
        ("en", "for 2 adults", "price up to 200 EUR for 2 adults", "Price dropped"),
        ("ru", "за 2 взрослых", "цена до 200 EUR за 2 взрослых", "Цена снизилась"),
    ],
)
def test_alert_texts_follow_the_locale(
    locale: Any, party: str, condition: str, subject_word: str
) -> None:
    a = alert()
    found = Found(price=Decimal(150), departure=None, return_date=None, baggage_unknown=True)
    with use_locale(locale):
        assert party_text(a) == party
        assert condition_text(a) == condition
        body = price_drop_text(a, found, "reason", "https://s", "https://m")
        assert body.startswith(f"✈️ {subject_word}")
        assert "https://m" in confirm_email_text(a, "https://m")
    if locale == "en":
        assert not re.search("[А-Яа-яЇїІіЄє]", body)


def test_flex_route_and_single_adult() -> None:
    a = alert(
        kind="flex",
        departure_until=date(2026, 12, 20),
        min_nights=3,
        max_nights=5,
        weekends=True,
        adults=1,
    )
    with use_locale("en"):
        assert route_text(a) == (
            "WAW → LIS, departure 05.12.2026 – 20.12.2026, 3–5 nights, weekends only"
        )
        assert party_text(a) == "for 1 adult"


def test_ai_data_texts_follow_the_locale() -> None:
    with use_locale("en"):
        assert duration_text(190) == "3 h 10 min"
        assert age_text(timedelta(hours=5)) == "5 h ago"
        assert TITLES["cheapest"] == "Cheapest"
    assert duration_text(190) == "3 год 10 хв"
    assert TITLES["balanced"] == "Збалансований"


def test_missing_key_is_an_error() -> None:
    with pytest.raises(KeyError):
        t("alerts.nope")
