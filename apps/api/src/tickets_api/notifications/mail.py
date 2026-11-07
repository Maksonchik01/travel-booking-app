"""Листи через SMTP (stdlib, у потоці — щоб не блокувати event loop). Без налаштувань — mock.

Адресу в логи не пишемо (GDPR) — лише домен.
"""

import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol

import structlog

log = structlog.get_logger(__name__)


class MailError(Exception):
    pass


class Mailer(Protocol):
    name: str

    async def send(self, to: str, subject: str, text: str) -> None: ...


class SmtpMailer:
    name = "smtp"

    def __init__(
        self, host: str, port: int, *, user: str | None, password: str | None, sender: str
    ) -> None:
        self._host, self._port = host, port
        self._user, self._password = user, password
        self._sender = sender

    async def send(self, to: str, subject: str, text: str) -> None:
        message = EmailMessage()
        message["From"] = self._sender
        message["To"] = to
        message["Subject"] = subject
        message.set_content(text)
        try:
            await asyncio.to_thread(self._send, message)
        except (smtplib.SMTPException, OSError) as exc:
            raise MailError(f"smtp: {type(exc).__name__}") from exc
        log.info("email.sent", domain=to.rsplit("@", 1)[-1])

    def _send(self, message: EmailMessage) -> None:
        context = ssl.create_default_context()
        if self._port == 465:
            with smtplib.SMTP_SSL(self._host, self._port, context=context, timeout=20) as smtp:
                self._login_and_send(smtp, message)
        else:
            with smtplib.SMTP(self._host, self._port, timeout=20) as smtp:
                smtp.starttls(context=context)
                self._login_and_send(smtp, message)

    def _login_and_send(self, smtp: smtplib.SMTP, message: EmailMessage) -> None:
        if self._user and self._password:
            smtp.login(self._user, self._password)
        smtp.send_message(message)


class MockMailer:
    """Без SMTP: лист лише в лог (і в `sent` — для тестів)."""

    name = "mock"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []

    async def send(self, to: str, subject: str, text: str) -> None:
        self.sent.append((to, subject, text))
        log.info("email.mock_message", domain=to.rsplit("@", 1)[-1], subject=subject)
