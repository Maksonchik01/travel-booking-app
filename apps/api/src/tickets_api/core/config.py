from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Уся конфігурація застосунку. Значення беруться лише з оточення / .env."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    log_json: bool = False
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3000"]
    )

    database_url: str = "postgresql+asyncpg://tickets:tickets@localhost:5432/tickets"
    redis_url: str = "redis://localhost:6379/0"
    readiness_timeout_s: float = 2.0

    sentry_dsn: SecretStr | None = None

    anthropic_api_key: SecretStr | None = None
    llm_model_parser: str = "claude-haiku-5-5"
    llm_model_explainer: str = "claude-sonnet-5-5"
    llm_max_calls_per_search: int = 3

    travelpayouts_token: SecretStr | None = None
    travelpayouts_marker: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        # У .env список задається через кому, а не як JSON.
        if isinstance(value, str):
            return [o.strip() for o in value.split(",") if o.strip()]
        return value

    @field_validator(
        "sentry_dsn",
        "anthropic_api_key",
        "travelpayouts_token",
        "travelpayouts_marker",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        # Порожній рядок у .env означає "не задано".
        return None if value == "" else value


@lru_cache
def get_settings() -> Settings:
    return Settings()
