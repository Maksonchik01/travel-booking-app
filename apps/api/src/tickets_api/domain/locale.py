"""Мова інтерфейсу (модуль 10b). ШІ-тексти для користувача — цією мовою (rules.md, п. 5:
поле "locale" у вхідних даних моделі)."""

from typing import Literal

UiLocale = Literal["en", "uk", "ru"]
DEFAULT_AI_LOCALE: UiLocale = "uk"
"""Без явної мови — як було до модуля 10b (веб завжди передає мову сторінки)."""
