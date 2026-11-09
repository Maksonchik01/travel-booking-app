"""Модуль 9c: розмови в акаунті — лише безпечні посилання й фото, обмежені розміри."""

import pytest
from pydantic import ValidationError
from tickets_api.domain.chats import ChatConversationBody

TURN = {"role": "user", "text": "Хочу в Лісабон"}


def body(**turn_extra: object) -> dict[str, object]:
    return {
        "mode": "trip",
        "title": "Лісабон",
        "created_at": 1,
        "updated_at": 2,
        "turns": [TURN, {"role": "assistant", "text": "Ось.", **turn_extra}],
    }


def test_links_and_cards_must_be_safe() -> None:
    ok = ChatConversationBody.model_validate(
        body(
            links={"trip": "/trip?from=WAW&to=LIS"},
            cards=[
                {
                    "card": {"kind": "stay", "image_url": "https://img.example/a.jpg"},
                    "href": "/stays?city=LIS#stay-x",
                }
            ],
        )
    )
    assert ok.turns[1].links is not None
    for bad in (
        {"links": {"trip": "javascript:alert(1)"}},
        {"links": {"trip": "//evil.example/x"}},
        {"links": {"trip": "https://evil.example"}},
        {"cards": [{"card": {"kind": "stay", "image_url": "http://img.example/a.jpg"}}]},
        {"cards": [{"card": {"kind": "trip", "stay": {"image_url": "data:x"}}}]},
        {"cards": [{"card": {"kind": "flight", "pad": "x" * 7000}}]},
    ):
        with pytest.raises(ValidationError):
            ChatConversationBody.model_validate(body(**bad))
    with pytest.raises(ValidationError):
        ChatConversationBody.model_validate({**body(), "turns": [TURN] * 81})
