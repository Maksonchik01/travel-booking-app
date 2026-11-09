import logging
import re
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog

# Логери, які uvicorn і arq налаштовують власними обробниками. Перенаправляємо їх у наш,
# інакше рядки дублюються або виходять у несумісному форматі.
_THIRD_PARTY_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access", "arq")
# httpx/httpcore на INFO логують повні URL запитів, а деякі API (SerpApi) приймають
# ключ лише в query string. Тож ці логери — не нижче WARNING.
_URL_LOGGERS = ("httpx", "httpcore")


# Другий рубіж (модуль 17.4): навіть якщо хтось залогує секрет чи email, у вивід він не піде.
SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "token",
        "manage_token",
        "access_token",
        "password",
        "secret",
        "authorization",
        "cookie",
        "email",
        "x-access-token",
        "x-internal-key",
    }
)
_SECRET_IN_TEXT = re.compile(r"(?i)\b(api_key|access_token|token|password|secret)=([^&\s\"']+)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
REDACTED = "[redacted]"


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return _EMAIL.sub(REDACTED, _SECRET_IN_TEXT.sub(rf"\1={REDACTED}", value))
    if isinstance(value, dict):
        return {
            k: REDACTED if str(k).lower() in SENSITIVE_KEYS else redact(v) for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return type(value)(redact(v) for v in value)
    return value


def redact_secrets(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog-процесор: ключі з SENSITIVE_KEYS — повністю, `api_key=…` і email у тексті — теж."""
    for key, value in list(event_dict.items()):
        event_dict[key] = REDACTED if key.lower() in SENSITIVE_KEYS else redact(value)
    return event_dict


def configure_logging(level: str = "INFO", *, json: bool = False) -> None:
    """Структуровані логи: JSON у проді, кольоровий вивід локально."""
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )
    shared: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        redact_secrets,
    ]
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                renderer,
            ],
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    for name in _THIRD_PARTY_LOGGERS:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    for name in _URL_LOGGERS:
        logging.getLogger(name).setLevel(max(logging.WARNING, root.level))
