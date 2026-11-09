"""Синхронізація розмов з помічником (модуль 9c) — лише за згодою (`users.chat_sync`).

Без згоди розмови живуть тільки в браузері (ADR 0007). Зі згодою браузер надсилає розмову
цілком (як вона збережена локально), сервер лише зберігає й віддає її тому самому
користувачу. Посилання й фото в репліках перевіряємо: лише відносні шляхи нашого сайту й
https-фото — синхронізовані дані не можуть підсунути `javascript:` чи чужий домен.
"""

import json
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

from tickets_api.domain.flights import _StrictInput

MAX_SYNCED_CONVERSATIONS = 30
MAX_SYNCED_TURNS = 80
MAX_CARD_JSON = 6_000
ChatModeName = Literal["flights", "stays", "trip"]
LocalPath = Annotated[str, StringConstraints(max_length=2_000, pattern=r"^/([^/\s][^\s]*)?$")]
"""Шлях нашого сайту (`/trip?...`), не `//host` і не схема."""


class SyncedCard(_StrictInput):
    card: dict[str, Any]
    """Картка результату (модуль 9b) — як її віддав API; розмір обмежено."""
    href: LocalPath | None = None
    trip: LocalPath | None = None

    @model_validator(mode="after")
    def _safe(self) -> Self:
        if len(json.dumps(self.card)) > MAX_CARD_JSON:
            raise ValueError("картка завелика")
        images = [self.card.get("image_url"), (self.card.get("stay") or {}).get("image_url")]
        if any(url is not None and not str(url).startswith("https://") for url in images):
            raise ValueError("фото — лише https")
        return self


class SyncedLinks(_StrictInput):
    flights: LocalPath | None = None
    stays: LocalPath | None = None
    trip: LocalPath | None = None


class SyncedTurn(_StrictInput):
    role: Literal["user", "assistant"]
    text: Annotated[str, StringConstraints(min_length=1, max_length=2_000)]
    links: SyncedLinks | None = None
    cards: list[SyncedCard] | None = Field(default=None, max_length=6)


class ChatConversationBody(_StrictInput):
    mode: ChatModeName
    title: Annotated[str, StringConstraints(max_length=120)] = ""
    created_at: int = Field(ge=0)
    """Мітки часу браузера (мс) — злиття «новіше перемагає»."""
    updated_at: int = Field(ge=0)
    turns: list[SyncedTurn] = Field(max_length=MAX_SYNCED_TURNS)


class ChatConversationOut(ChatConversationBody):
    id: str


class ChatSyncBody(_StrictInput):
    enabled: bool


class ChatSyncState(BaseModel):
    enabled: bool
    conversations: list[ChatConversationOut] = []


ConversationId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9-]{8,64}$")]


def conversation_out(conversation_id: str, data: str) -> ChatConversationOut:
    return ChatConversationOut(id=conversation_id, **json.loads(data))
