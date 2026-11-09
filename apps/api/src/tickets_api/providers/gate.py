"""Шлюз HTTP-запитів до одного джерела (модуль 17.2, ADR 0034).

- **Ліміт одночасних запитів** (семафор): кілька пошуків разом не засипають API десятками
  паралельних запитів — зайві чекають своєї черги.
- **Повтор із контрольованою затримкою** лише для транзитних збоїв: обрив з'єднання, 502/503/504,
  за політикою — ще й тайм-аут. Затримка росте вдвічі, з випадковим розкидом (jitter), щоб
  повтори різних запитів не били в API одночасно. 429 і 4xx не повторюємо: квота чи помилка
  запиту від повтору не зникнуть.

Загальний тайм-аут джерела (`FlightSearchService`, `asyncio.wait_for`) — над шлюзом: повтори
вкладаються в нього або скасовуються разом із пошуком.
"""

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx
import structlog

log = structlog.get_logger(__name__)

TRANSIENT_STATUSES = frozenset({502, 503, 504})


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 2
    """Усього спроб (1 — без повторів)."""
    base_delay_s: float = 0.5
    max_delay_s: float = 4.0
    retry_timeouts: bool = True
    """False — тайм-аут не повторюємо (SerpApi: довгий запит, повтор не вкладеться в ліміт)."""

    def delay(self, attempt: int, jitter: float) -> float:
        """Пауза після `attempt`-ї невдалої спроби; `jitter` ∈ [0, 1) → множник 0,5–1."""
        raw: float = min(self.max_delay_s, self.base_delay_s * 2.0 ** (attempt - 1))
        return raw * (0.5 + jitter / 2)


class ProviderGate:
    def __init__(
        self,
        name: str,
        *,
        max_concurrency: int,
        retry: RetryPolicy | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self.name = name
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._retry = retry or RetryPolicy()
        self._sleep = sleep
        self._jitter = jitter

    async def send(self, call: Callable[[], Awaitable[httpx.Response]]) -> httpx.Response:
        """Виконати запит (`call` створює його заново на кожну спробу). Остання невдача —
        як є: виняток httpx чи відповідь з кодом, які розбирає адаптер джерела."""
        attempts = self._retry.attempts
        for attempt in range(1, attempts + 1):
            async with self._semaphore:
                try:
                    response = await call()
                except httpx.TimeoutException:
                    if not self._retry.retry_timeouts or attempt == attempts:
                        raise
                    reason = "timeout"
                except httpx.TransportError as exc:
                    if attempt == attempts:
                        raise
                    reason = type(exc).__name__
                else:
                    if response.status_code not in TRANSIENT_STATUSES or attempt == attempts:
                        return response
                    reason = f"HTTP {response.status_code}"
            # Пауза — поза семафором: місце в черзі не тримаємо, поки чекаємо.
            log.info("provider.retry", provider=self.name, attempt=attempt, reason=reason)
            await self._sleep(self._retry.delay(attempt, self._jitter()))
        raise AssertionError("unreachable")  # pragma: no cover
