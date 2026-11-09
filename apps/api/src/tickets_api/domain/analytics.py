"""Продуктова аналітика (модуль 19, ADR 0038): анонімні події використання сервісу.

Мінімум даних (GDPR): назва події з переліку й кілька міток-перелічень. Жодних ідентифікаторів
людини чи сесії, IP, cookies, тексту запитів, маршрутів, сум — лише «що сталося», щоб рахувати
частоти й воронки (пошук → результат → перехід до продавця).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

EventName = Literal[
    "search_started",
    "search_succeeded",
    "search_empty",
    "search_failed",
    "filters_applied",
    "offer_opened",
    "compare_opened",
    "outbound",
    "favorite_added",
    "trip_saved",
    "cheaper_requested",
    "ai_optimize",
    "alert_created",
    "ai_to_planner",
]
PropKey = Literal["mode", "kind", "reason", "results", "source"]
"""mode — flights / stays / trip; kind — тип об'єкта; reason — код помилки; results — кошик
кількості (0, 1-5, 6-20, 21+); source — звідки дія (form, chat, card…)."""
PropValue = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_+-]{1,24}$")]
"""Лише короткі мітки: вільний текст (а з ним — персональні дані) сюди не пролізе."""
RETENTION_DAYS = 90


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: EventName
    props: dict[PropKey, PropValue] = Field(default_factory=dict, max_length=4)


def results_bucket(count: int) -> str:
    """Кількість результатів — кошиком, не точним числом."""
    if count <= 0:
        return "0"
    if count <= 5:
        return "1-5"
    if count <= 20:
        return "6-20"
    return "21+"


__all__ = ["RETENTION_DAYS", "EventIn", "EventName", "PropKey", "results_bucket"]
