from tickets_api.core.config import Settings
from tickets_api.notifications.mail import Mailer, MockMailer, SmtpMailer


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
