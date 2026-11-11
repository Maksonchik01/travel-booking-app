import httpx

from tickets_api.core.config import Settings
from tickets_api.notifications.mail import Mailer, MockMailer, SmtpMailer
from tickets_api.notifications.telegram import MockTelegram, TelegramBot, TelegramClient


def build_mailer(settings: Settings) -> Mailer:
    """SMTP, якщо налаштовано (SMTP_HOST і EMAIL_FROM); інакше — mock (лише в лог)."""
    if settings.smtp_host and settings.email_from:
        return SmtpMailer(
            settings.smtp_host,
            settings.smtp_port,
            user=settings.smtp_user,
            password=settings.smtp_password.get_secret_value() if settings.smtp_password else None,
            sender=settings.email_from,
        )
    return MockMailer()


def build_telegram(settings: Settings, http: httpx.AsyncClient) -> TelegramClient:
    """Bot API, якщо є TELEGRAM_BOT_TOKEN; інакше — mock (лише в лог)."""
    if settings.telegram_bot_token is None:
        return MockTelegram()
    return TelegramBot(
        http, settings.telegram_bot_token.get_secret_value(), base_url=settings.telegram_base_url
    )
