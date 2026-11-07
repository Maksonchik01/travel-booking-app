import logging

import pytest
from tickets_api.core.config import Settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry, scrub_breadcrumb


def test_cors_origins_are_parsed_from_comma_separated_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "http://a.test, http://b.test")

    settings = Settings(_env_file=None)

    assert settings.cors_origins == ["http://a.test", "http://b.test"]


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+asyncpg"])
def test_hosting_database_url_gets_async_driver(
    monkeypatch: pytest.MonkeyPatch, scheme: str
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"{scheme}://u:p@db-host/tickets")

    settings = Settings(_env_file=None)

    assert settings.database_url == "postgresql+asyncpg://u:p@db-host/tickets"


def test_libpq_sslmode_becomes_asyncpg_ssl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://u:p@pooler.example:5432/postgres?sslmode=require"
    )

    settings = Settings(_env_file=None)

    assert (
        settings.database_url == "postgresql+asyncpg://u:p@pooler.example:5432/postgres?ssl=require"
    )


def test_empty_secrets_are_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", "")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("SCORING_CONFIG_PATH", "")

    settings = Settings(_env_file=None)

    assert settings.sentry_dsn is None
    assert settings.deepseek_api_key is None
    assert settings.scoring_config_path is None
    assert init_sentry(settings) is False


def test_secrets_are_not_leaked_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-very-secret")

    settings = Settings(_env_file=None)

    assert "sk-very-secret" not in repr(settings)


def test_llm_models_are_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PARSER", "model-a")
    monkeypatch.setenv("LLM_MODEL_EXPLAINER", "model-b")

    settings = Settings(_env_file=None)

    assert (settings.llm_model_parser, settings.llm_model_explainer) == ("model-a", "model-b")


def test_deepseek_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")

    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
        Settings(_env_file=None)


def test_llm_is_off_by_default() -> None:
    assert Settings(_env_file=None).llm_provider == "off"


def test_third_party_loggers_go_through_single_handler() -> None:
    noisy = logging.getLogger("uvicorn.access")
    noisy.addHandler(logging.StreamHandler())
    noisy.propagate = False

    configure_logging("INFO")

    assert noisy.handlers == []
    assert noisy.propagate is True
    assert len(logging.getLogger().handlers) == 1


def test_httpx_url_logs_are_suppressed() -> None:
    configure_logging("DEBUG")

    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING


def test_secrets_are_scrubbed_from_sentry_breadcrumbs() -> None:
    crumb = {
        "message": "GET https://serpapi.com/search.json?engine=google_flights&api_key=abc123",
        "data": {"url": "https://serpapi.com/search.json?api_key=abc123&q=1"},
    }

    scrubbed = scrub_breadcrumb(crumb, None)

    assert "abc123" not in str(scrubbed)
    assert "api_key=[Filtered]&q=1" in scrubbed["data"]["url"]


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"FLIGHT_PROVIDERS": "serpapi"}, "SERPAPI_KEY"),
        ({"CALENDAR_PROVIDERS": "travelpayouts"}, "TRAVELPAYOUTS_TOKEN"),
    ],
)
def test_providers_require_credentials(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], message: str
) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        Settings(_env_file=None)


@pytest.mark.parametrize(
    "raw", ['"https://k@o1.ingest.de.sentry.io/2"', "  'https://k@o1.ingest.de.sentry.io/2' "]
)
def test_secret_pasted_with_quotes_is_unquoted(raw: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", raw)
    monkeypatch.setenv("INTERNAL_API_KEY", f'"{"k" * 32}"')
    settings = Settings(_env_file=None)
    assert settings.sentry_dsn is not None
    assert settings.sentry_dsn.get_secret_value() == "https://k@o1.ingest.de.sentry.io/2"
    assert settings.internal_api_key is not None
    assert settings.internal_api_key.get_secret_value() == "k" * 32


def test_bad_sentry_dsn_does_not_crash_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", "not a dsn")
    assert init_sentry(Settings(_env_file=None)) is False
