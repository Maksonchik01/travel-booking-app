"""Ідентифікатор запиту й базові заголовки безпеки API (V3, етап 4).

- `X-Request-ID`: беремо від вебу (той передає `x-vercel-id` відвідувача), якщо він схожий на
  ідентифікатор, інакше генеруємо. Він потрапляє в кожен рядок логу цього запиту
  (structlog contextvars), у тег Sentry і в заголовок відповіді — збій можна знайти за ним.
  Без маршрутів, IP чи тексту запиту.
- `X-Content-Type-Options: nosniff` і `Cache-Control: no-store` за замовчуванням: відповіді API
  персональні або короткоживучі, проміжні кеші їх не зберігають.
"""

import re
import uuid

import sentry_sdk
import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

HEADER = "x-request-id"
_VALID = re.compile(r"^[A-Za-z0-9:_-]{8,128}$")


def request_id_from(headers: list[tuple[bytes, bytes]]) -> str:
    for name, value in headers:
        if name == HEADER.encode():
            candidate = value.decode("latin-1")
            if _VALID.match(candidate):
                return candidate
    return uuid.uuid4().hex


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = request_id_from(scope.get("headers", []))
        structlog.contextvars.bind_contextvars(request_id=request_id)
        sentry_sdk.get_isolation_scope().set_tag("request_id", request_id)

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                headers.append((HEADER.encode(), request_id.encode()))
                if b"x-content-type-options" not in present:
                    headers.append((b"x-content-type-options", b"nosniff"))
                if b"cache-control" not in present:
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
