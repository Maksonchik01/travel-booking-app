from typing import Literal

from pydantic import BaseModel, Field


class ClickIn(BaseModel):
    """Клік «Забронювати». Посилання перевіряє й редиректить веб; сюди — лише облік."""

    kind: Literal["flight", "stay"]
    source: str = Field(pattern=r"^[a-z0-9_]{1,32}$", examples=["travelpayouts"])
    host: str = Field(
        pattern=r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
        max_length=255,
        examples=["www.aviasales.com"],
    )
