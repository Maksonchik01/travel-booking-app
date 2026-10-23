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
    )
    return True
