from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

FlightProviderName = Literal["mock", "travelpayouts", "serpapi"]
StayProviderName = Literal["mock"]
LLMProviderName = Literal["off", "mock", "deepseek"]
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

    # Ліміти запитів на клієнта за годину (core/rate_limit.py). Пошук захищає квоту SerpApi,
    # ai — бюджет DeepSeek, auth — реєстрацію й скидання пароля від спаму.
    internal_api_key: SecretStr | None = None
    """Спільний секрет веб ↔ API: лише з ним API вірить X-Client-IP (IP відвідувача)."""
    rate_limit_search_per_hour: int = Field(default=40, ge=1)
    rate_limit_ai_per_hour: int = Field(default=30, ge=1)
    rate_limit_auth_per_hour: int = Field(default=20, ge=1)
    rate_limit_clicks_per_hour: int = Field(default=200, ge=1)

    # LLM (ADR 0007): off — ШІ-функції вимкнені; mock — детерміновані відповіді (e2e, dev).
    llm_provider: LLMProviderName = "off"
    deepseek_api_key: SecretStr | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    llm_model_parser: str = "deepseek-flash"
    llm_model_explainer: str = "deepseek-v4-pro"
    llm_model_assistant: str = "deepseek-flash"
    llm_max_calls_per_search: int = Field(default=3, ge=1, le=10)
    """Викликів моделі на один запит користувача (розбір з інструментами — кілька кроків)."""
    llm_max_calls_per_chat_turn: int = Field(default=6, ge=2, le=12)
    """Викликів моделі на одну репліку чату: інструменти + відповідь + одна спроба виправити."""
    llm_timeout_s: float = Field(default=45.0, gt=0)
    llm_cache_ttl_s: int = 86400
    llm_pricing_path: Path | None = None
    """None — вбудований tickets_api/llm/pricing.toml."""
    llm_prompts_dir: Path | None = None
    """Каталог з rules/ і sub-agents/; None — шукаємо вгору від пакета (корінь репозиторію)."""

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
    # Житло: поки лише mock (ADR 0008) — реальне джерело додасться ще одним адаптером.
    stay_providers: Annotated[list[StayProviderName], NoDecode] = Field(
        default_factory=lambda: list[StayProviderName](["mock"])
    )
    stay_scoring_config_path: Path | None = None
    """None — вбудований tickets_api/scoring/stays.toml."""

    # Алерти (етап 7, ADR 0010). Ціни для перевірок — з кешованого джерела, не з SerpApi:
    # кожна підписка перевіряється регулярно, і живі запити вичерпали б квоту за дні.
    alert_providers: Annotated[list[FlightProviderName], NoDecode] = Field(
        default_factory=lambda: list[FlightProviderName](["mock"])
    )
    alert_check_interval_hours: int = Field(default=6, ge=1, le=24)
    alert_min_hours_between_notifications: int = Field(default=24, ge=1, le=168)
    alert_max_searches_per_run: int = Field(default=300, ge=1, le=10_000)
    """Скільки різних пошуків робить одна перевірка (ТЗ 11.4); решта — наступного разу."""
    alert_max_active_per_owner: int = Field(default=20, ge=1, le=1000)
    """Ліміт підписок (крім вимкнених) на акаунт, email чи Telegram-чат."""
    public_web_url: str = "http://localhost:3000"
    """Адреса сайту для посилань у сповіщеннях (керування підпискою, результати пошуку)."""
    telegram_bot_token: SecretStr | None = None
    telegram_bot_username: str | None = None
    """Без @; для посилання t.me/<бот>?start=<код>."""
    telegram_base_url: str = "https://api.telegram.org"
    # Акаунти (ADR 0011). Google — OAuth 2.0 з PKCE; без ключів кнопка Google вимкнена.
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    session_ttl_days: int = Field(default=30, ge=1, le=365)
    login_max_failures: int = Field(default=5, ge=3, le=20)
    """Стільки невдалих спроб входу за 15 хв — і пауза (захист від підбору пароля)."""
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    email_from: str | None = None

    serpapi_key: SecretStr | None = None
    serpapi_base_url: str = "https://serpapi.com"
    # Кожен запит до SerpApi — платний (безкоштовно 250/міс), тож пошук має бюджет.
    serpapi_max_requests_per_search: int = Field(default=4, ge=1, le=20)
    flex_live_date_pairs: int = Field(default=2, ge=0, le=4)
    """Гнучкі дати: скільки найдешевших кешованих пар дат перевіряти наживо (ADR 0016)."""
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
    price_live_fresh_min: int = Field(default=30, ge=1, le=1440)
    """Жива ціна молодша за це — «щойно перевірена»; старша — «варто перевірити» (17.3)."""
    price_cached_stale_days: int = Field(default=3, ge=1, le=60)
    """Кешована ціна, знайдена давніше, — «варто перевірити»."""

    @field_validator(
        "cors_origins",
        "flight_providers",
        "calendar_providers",
        "stay_providers",
        "alert_providers",
        mode="before",
    )
    @classmethod
    def _split_csv(cls, value: object) -> object:
        # У .env список задається через кому, а не як JSON.
        if isinstance(value, str):
            return [o.strip() for o in value.split(",") if o.strip()]
        return value

    @field_validator("database_url")
    @classmethod
    def _async_driver(cls, value: str) -> str:
        # Хостинги (Render, Supabase) дають postgres:// чи postgresql:// — нам потрібен asyncpg.
        for scheme in ("postgres://", "postgresql://"):
            if value.startswith(scheme):
                value = "postgresql+asyncpg://" + value.removeprefix(scheme)
        # libpq-параметр sslmode asyncpg не знає: його відповідник — ssl (require, verify-full…).
        url = urlsplit(value)
        if "sslmode" in url.query:
            query = [("ssl" if k == "sslmode" else k, v) for k, v in parse_qsl(url.query)]
            value = urlunsplit(url._replace(query=urlencode(query)))
        return value

    @field_validator(
        "sentry_dsn",
        "internal_api_key",
        "deepseek_api_key",
        "llm_pricing_path",
        "llm_prompts_dir",
        "travelpayouts_token",
        "travelpayouts_marker",
        "scoring_config_path",
        "stay_scoring_config_path",
        "telegram_bot_token",
        "google_client_id",
        "google_client_secret",
        "telegram_bot_username",
        "smtp_host",
        "smtp_user",
        "smtp_password",
        "email_from",
        "serpapi_key",
        "serpapi_market",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        # Порожній рядок у .env означає "не задано". Значення, скопійоване з .env у панель
        # хостингу разом із лапками (SENTRY_DSN="https://…"), приймаємо без них.
        if isinstance(value, str):
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1].strip()
        return None if value == "" else value

    @model_validator(mode="after")
    def _providers_have_credentials(self) -> Self:
        uses_tp = "travelpayouts" in [
            *self.flight_providers,
            *self.calendar_providers,
            *self.alert_providers,
        ]
        if uses_tp and self.travelpayouts_token is None:
            raise ValueError("travelpayouts увімкнено без TRAVELPAYOUTS_TOKEN")
        if "serpapi" in self.alert_providers:
            raise ValueError("ALERT_PROVIDERS не може містити serpapi: перевірки вичерпають квоту")
        if (self.google_client_id is None) != (self.google_client_secret is None):
            raise ValueError("GOOGLE_CLIENT_ID і GOOGLE_CLIENT_SECRET задаються лише разом")
        if self.telegram_bot_token is not None and not self.telegram_bot_username:
            raise ValueError("TELEGRAM_BOT_TOKEN без TELEGRAM_BOT_USERNAME (для посилання на бота)")
        if "serpapi" in self.flight_providers and self.serpapi_key is None:
            raise ValueError("FLIGHT_PROVIDERS містить serpapi без SERPAPI_KEY")
        if self.llm_provider == "deepseek" and self.deepseek_api_key is None:
            raise ValueError("LLM_PROVIDER=deepseek без DEEPSEEK_API_KEY")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
