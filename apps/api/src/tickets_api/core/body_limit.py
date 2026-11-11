"""Ліміт розміру тіла запиту (ADR 0056): за `Content-Length` і потоком байтів — 413.

Найбільші легітимні тіла — розмова з помічником (20 реплік + поточні пошуки) і фото профілю
(≤ 300 КБ, `user_avatars`); решта — короткі JSON-запити пошуку.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 1024 * 1024


class _TooLargeError(Exception):
    pass


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    too_big = int(value) > self.max_bytes
                except ValueError:
                    too_big = True
                if too_big:
                    await _reject(send)
                    return
        received = 0
        exceeded = False
        rejected = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    raise _TooLargeError
            return message

        async def guarded_send(message: Message) -> None:
            # FastAPI сам ловить помилку читання тіла й відповідає 400 — підміняємо на 413.
            nonlocal rejected
            if not exceeded:
                await send(message)
            elif not rejected:
                rejected = True
                await _reject(send)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _TooLargeError:
            if not rejected:
                await _reject(send)


async def _reject(send: Send) -> None:
    body = b'{"detail":"payload_too_large"}'
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", b"%d" % len(body)),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
