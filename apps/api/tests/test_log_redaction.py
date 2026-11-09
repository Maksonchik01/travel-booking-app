"""Модуль 17.4: секрети й email не потрапляють у логи, навіть якщо їх передали випадково."""

import json
import logging

import pytest
import structlog
from tickets_api.core.logging import REDACTED, configure_logging, redact_secrets


def test_sensitive_keys_and_secrets_in_text_are_masked() -> None:
    event = redact_secrets(
        None,
        "info",
        {
            "event": "provider.error",
            "api_key": "sk-123",
            "email": "me@example.com",
            "url": "https://serpapi.com/search.json?engine=google_flights&api_key=abc123&q=x",
            "detail": "contact me@example.com please",
            "nested": {"Authorization": "Bearer x", "ok": 1},
            "provider": "serpapi",
        },
    )

    assert event["api_key"] == REDACTED
    assert event["email"] == REDACTED
    assert "abc123" not in event["url"]
    assert f"api_key={REDACTED}" in event["url"]
    assert event["detail"] == f"contact {REDACTED} please"
    assert event["nested"] == {"Authorization": REDACTED, "ok": 1}
    assert event["provider"] == "serpapi"


def test_redaction_is_wired_into_log_output(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", json=True)
    structlog.get_logger("t").warning("leak", token="secret-token", note="api_key=zzz")  # noqa: S106
    logging.getLogger().handlers[0].flush()

    line = capsys.readouterr().out.strip().splitlines()[-1]
    record = json.loads(line)
    assert record["token"] == REDACTED
    assert "zzz" not in line
