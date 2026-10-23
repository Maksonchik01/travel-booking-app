import logging
import sys

import structlog

# Логери, які uvicorn і arq налаштовують власними обробниками. Перенаправляємо їх у наш,
# інакше рядки дублюються або виходять у несумісному форматі.
_THIRD_PARTY_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access", "arq")


def configure_logging(level: str = "INFO", *, json: bool = False) -> None:
    """Структуровані логи: JSON у проді, кольоровий вивід локально."""
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )
    shared: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
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
