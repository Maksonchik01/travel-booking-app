"""Тексти, які API формує сам для людини (модуль 18.1, ADR 0036): сповіщення й листи, бот,
дані для ШІ (тривалість, «N год тому», назви варіантів). Мови — ті самі, що в UI: en / uk / ru.

Каталоги — `messages/{en,uk,ru}.json`, однакові ключі (перевіряє test_i18n). Значення —
рядок з `{name}`-підстановками або множина `{"one", "few", "many", "other"}` для `count`.

Мова — у контекстній змінній: один раз на запит (обробка оновлення бота, пояснення ШІ) чи
`with use_locale(...)` навколо одного листа. Без контексту — DEFAULT_LOCALE (українська:
так було до модуля 18, і так пишуть ті, хто не повідомив мову).
"""

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from functools import cache
from pathlib import Path
from typing import Any, cast, get_args

from tickets_api.domain.locale import UiLocale

DEFAULT_LOCALE: UiLocale = "uk"
LOCALES: tuple[UiLocale, ...] = get_args(UiLocale)
_MESSAGES = Path(__file__).with_name("messages")
_current: ContextVar[UiLocale] = ContextVar("text_locale", default=DEFAULT_LOCALE)


def as_locale(value: str | None) -> UiLocale | None:
    """«uk», «uk-UA», «ru», «en-GB» → мова UI; інша чи невідома — None."""
    if not value:
        return None
    code = value.strip().lower()[:2]
    return code if code in LOCALES else None


def telegram_locale(language_code: str | None) -> UiLocale | None:
    """Мова з налаштувань Telegram: наші — як є, будь-яка інша відома — англійська."""
    if not language_code:
        return None
    return as_locale(language_code) or "en"


def current_locale() -> UiLocale:
    return _current.get()


def set_locale(locale: UiLocale) -> None:
    """Для всього поточного завдання (обробка одного оновлення бота, одного запиту)."""
    _current.set(locale)


@contextmanager
def use_locale(locale: UiLocale | None) -> Iterator[UiLocale]:
    token = _current.set(locale or DEFAULT_LOCALE)
    try:
        yield _current.get()
    finally:
        _current.reset(token)


@cache
def catalog(locale: UiLocale) -> dict[str, Any]:
    with (_MESSAGES / f"{locale}.json").open(encoding="utf-8") as f:
        return cast(dict[str, Any], json.load(f))


def plural_form(locale: UiLocale, n: int) -> str:
    """CLDR для наших мов: uk/ru — one / few / many, en — one / other."""
    if locale == "en":
        return "one" if n == 1 else "other"
    if n % 10 == 1 and n % 100 != 11:
        return "one"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "few"
    return "many"


def t(key: str, *, locale: UiLocale | None = None, **params: Any) -> str:
    """Текст за ключем («alerts.price_drop.title») мовою контексту. Немає ключа — KeyError:
    це помилка коду, і тест каталогу її ловить."""
    lang = locale or current_locale()
    node: Any = catalog(lang)
    for part in key.split("."):
        node = node[part]
    if isinstance(node, dict):
        count = params.get("count")
        if not isinstance(count, int):
            raise KeyError(f"{key}: plural without int count")
        node = node.get(plural_form(lang, count)) or node["other"]
    return str(node).format(**params)


class Labels(Mapping[str, str]):
    """Назви за ключем (`labels["cheapest"]`) мовою контексту на момент звернення — для місць,
    де раніше були словники українських назв."""

    def __init__(self, prefix: str, keys: tuple[str, ...]) -> None:
        self._prefix = prefix
        self._keys = keys

    def __getitem__(self, key: str) -> str:
        if key not in self._keys:
            raise KeyError(key)
        return t(f"{self._prefix}.{key}")

    def __iter__(self) -> Iterator[str]:
        return iter(self._keys)

    def __len__(self) -> int:
        return len(self._keys)
