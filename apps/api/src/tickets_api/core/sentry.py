import re
from typing import Any

import sentry_sdk

from tickets_api.core.config import Settings


def init_sentry(settings: Settings) -> bool:
    """Вмикає Sentry лише якщо задано SENTRY_DSN. Повертає, чи увімкнено."""
    if settings.sentry_dsn is None:
        return False
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.app_env,
        traces_sample_rate=0.1,
        send_default_pii=False,  # GDPR: без IP, cookies, заголовків
        before_breadcrumb=scrub_breadcrumb,
    )
    return True


_SECRET_PARAM = re.compile(r"((?:api_key|token|access_token)=)[^&\s]+", re.IGNORECASE)


def scrub_secrets(text: str) -> str:
    """Прибирає ключі з URL (SerpApi приймає api_key лише в query string)."""
    return _SECRET_PARAM.sub(r"\1[Filtered]", text)


def scrub_breadcrumb(crumb: dict[str, Any], hint: Any) -> dict[str, Any]:
    data = crumb.get("data") or {}
    for field in ("url", "http.query"):
        if isinstance(data.get(field), str):
            data[field] = scrub_secrets(data[field])
    if isinstance(crumb.get("message"), str):
        crumb["message"] = scrub_secrets(crumb["message"])
    return crumb
