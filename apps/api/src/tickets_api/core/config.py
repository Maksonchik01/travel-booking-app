from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

FlightProviderName = Literal["mock", "travelpayouts", "serpapi"]
CalendarProviderName = Literal["mock", "travelpayouts"]


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
    travelpayouts_base_url: str = "https://api.travelpayouts.com"

    # Провайдери через кому. Пошук: mock, travelpayouts, serpapi (живі ціни Google Flights).
    # Календар: mock, travelpayouts (у serpapi календаря немає).
    flight_providers: Annotated[list[FlightProviderName], NoDecode] = Field(
        default_factory=lambda: list[FlightProviderName](["mock"])
    )
    calendar_providers: Annotated[list[CalendarProviderName], NoDecode] = Field(
        default_factory=lambda: list[CalendarProviderName](["mock"])
    )

    serpapi_key: SecretStr | None = None
    serpapi_base_url: str = "https://serpapi.com"
    # Кожен запит до SerpApi — платний (безкоштовно 250/міс), тож пошук має бюджет.
    serpapi_max_requests_per_search: int = Field(default=4, ge=1, le=20)
    serpapi_returns_per_date: int = Field(default=2, ge=1, le=10)
    serpapi_timeout_s: float = Field(default=30.0, gt=0)
    """Загальний час на пошук: Google Flights відповідає 1–15 с на запит, і запитів кілька."""
    serpapi_request_timeout_s: float = Field(default=20.0, gt=0)
    serpapi_market: str | None = None
    """Країна Google (`gl`, напр. "pl"), з якої дивимось ціни; None — за замовчуванням Google."""
    """Для скількох найдешевших вильотів підвантажувати зворотні рейси (+1 запит кожен)."""
    provider_timeout_s: float = 8.0
    scoring_config_path: Path | None = None
    """None — вбудований tickets_api/scoring/config.toml."""
    provider_cache_ttl_s: int = 1800

    @field_validator("cors_origins", "flight_providers", "calendar_providers", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        # У .env список задається через кому, а не як JSON.
        if isinstance(value, str):
            return [o.strip() for o in value.split(",") if o.strip()]
        return value

    @field_validator(
        "sentry_dsn",
        "anthropic_api_key",
        "travelpayouts_token",
        "travelpayouts_marker",
        "scoring_config_path",
        "serpapi_key",
        "serpapi_market",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        # Порожній рядок у .env означає "не задано".
        return None if value == "" else value

    @model_validator(mode="after")
    def _providers_have_credentials(self) -> Self:
        uses_tp = "travelpayouts" in [*self.flight_providers, *self.calendar_providers]
        if uses_tp and self.travelpayouts_token is None:
            raise ValueError("travelpayouts увімкнено без TRAVELPAYOUTS_TOKEN")
        if "serpapi" in self.flight_providers and self.serpapi_key is None:
            raise ValueError("FLIGHT_PROVIDERS містить serpapi без SERPAPI_KEY")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
