"""Довідкові курси ЄЦБ (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml).

Безкоштовно, без ключа; оновлюються раз на робочий день (~16:00 CET). Формат звірено з
реальною відповіддю (tests/fixtures/ecb/eurofxref-daily.xml, листопад 2026):
`<Cube currency='USD' rate='1.1165'/>` — одиниць валюти за 1 EUR. Гривні в списку ЄЦБ немає.

Потрібні лише скорингу, щоб перевести ваги з EUR у валюту пошуку (ціни дає саме джерело у
валюті запиту — ми їх не конвертуємо). Кеш у Redis на 12 год; збій — останній відомий курс,
а якщо його немає — `None` (тоді скоринг чесно не порівнює, ADR 0005).
"""

import json
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

import httpx
import structlog
from redis.asyncio import Redis

log = structlog.get_logger(__name__)

ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
CACHE_KEY = "fx:ecb:eur"
STALE_KEY = "fx:ecb:eur:last"
CACHE_TTL_S = 12 * 3600


def parse_ecb(xml: str) -> dict[str, Decimal]:
    """Курси з XML ЄЦБ; EUR = 1. Биті рядки пропускаємо."""
    rates = {"EUR": Decimal(1)}
    for cube in ET.fromstring(xml).iter():  # noqa: S314 — офіційне джерело, лише атрибути
        code, rate = cube.get("currency"), cube.get("rate")
        if code and rate:
            try:
                value = Decimal(rate)
            except InvalidOperation:
                continue
            if value > 0:
                rates[code.upper()] = value
    return rates


class EcbRates:
    def __init__(self, http: httpx.AsyncClient, redis: Redis, *, url: str = ECB_DAILY_URL) -> None:
        self._http = http
        self._redis = redis
        self._url = url

    async def rate(self, base: str, currency: str) -> Decimal | None:
        """Одиниць `currency` за одиницю `base`; None — курсу немає."""
        if base == currency:
            return Decimal(1)
        rates = await self._rates()
        if base not in rates or currency not in rates:
            return None
        return rates[currency] / rates[base]

    async def _rates(self) -> dict[str, Decimal]:
        cached = await self._get(CACHE_KEY)
        if cached:
            return cached
        try:
            response = await self._http.get(self._url, timeout=10.0)
            response.raise_for_status()
            rates = parse_ecb(response.text)
        except (httpx.HTTPError, ET.ParseError) as exc:
            log.warning("fx.ecb_failed", error=type(exc).__name__)
            return await self._get(STALE_KEY) or {}
        payload = json.dumps({k: str(v) for k, v in rates.items()})
        try:
            await self._redis.set(CACHE_KEY, payload, ex=CACHE_TTL_S)
            await self._redis.set(STALE_KEY, payload)
        except Exception as exc:  # без кешу курс однаково є
            log.warning("fx.cache_failed", error=type(exc).__name__)
        return rates

    async def _get(self, key: str) -> dict[str, Decimal] | None:
        try:
            raw = await self._redis.get(key)
        except Exception as exc:
            log.warning("fx.cache_failed", error=type(exc).__name__)
            return None
        if not raw:
            return None
        return {k: Decimal(v) for k, v in json.loads(raw).items()}
