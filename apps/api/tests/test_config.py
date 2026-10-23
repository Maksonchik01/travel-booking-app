import logging

import pytest
from tickets_api.core.config import Settings
from tickets_api.core.logging import configure_logging
from tickets_api.core.sentry import init_sentry


def test_cors_origins_are_parsed_from_comma_separated_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "http://a.test, http://b.test")

    settings = Settings(_env_file=None)

    assert settings.cors_origins == ["http://a.test", "http://b.test"]


def test_empty_secrets_are_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    settings = Settings(_env_file=None)

    assert settings.sentry_dsn is None
    assert settings.anthropic_api_key is None
    assert init_sentry(settings) is False


def test_secrets_are_not_leaked_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-very-secret")

    settings = Settings(_env_file=None)

    assert "sk-very-secret" not in repr(settings)


def test_llm_models_are_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PARSER", "model-a")
    monkeypatch.setenv("LLM_MODEL_EXPLAINER", "model-b")

    settings = Settings(_env_file=None)

    assert (settings.llm_model_parser, settings.llm_model_explainer) == ("model-a", "model-b")


def test_third_party_loggers_go_through_single_handler() -> None:
    noisy = logging.getLogger("uvicorn.access")
    noisy.addHandler(logging.StreamHandler())
    noisy.propagate = False

    configure_logging("INFO")

    assert noisy.handlers == []
    assert noisy.propagate is True
    assert len(logging.getLogger().handlers) == 1
