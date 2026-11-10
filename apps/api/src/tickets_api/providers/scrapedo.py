"""Адаптер Google Flights через scrape.do — ЖИВІ ціни, друга дорога до видачі, що й у SerpApi.

Документація: https://scrape.do/documentation/google-scraper-api/flights/. Звірено з реальними
відповідями (листопад 2026, tests/fixtures/scrapedo/):
- формат ітинераріїв — як у SerpApi (`best_flights`/`other_flights`, сегменти з місцевим часом
  без поясу, `layovers`, `total_duration`, `price`), тож розбір спільний (`SerpApiFlightProvider`);
- `departure_token` для зворотних рейсів scrape.do ІГНОРУЄ (повертає ту саму першу сторінку), а
  ціна туди-назад без деталей повернення — не пропозиція. Тому туди-назад — два запити в один
  бік і комбінації «два окремі квитки» (`Offer.separate_tickets`, ціна — сума двох квитків);
- варіантів бронювання (`booking_options`) немає → продавців не перевіряємо (`booking_ref=None`),
  посилання на видачу Google Flights (`search_metadata`) у відповіді немає → будуємо пошук `q=`;
- кожен запит — 10 кредитів (безкоштовно 1000/міс), тож пошук має бюджет запитів.

Токен передається лише в query string (`token`), тому в помилки й логи URL не потрапляє
(`redact_secrets` маскує `token=` у тексті).
"""

import asyncio
import hashlib
from datetime import date, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from tickets_api.domain.flights import FlightQuery, Offer
from tickets_api.domain.sellers import SellerOffer
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
)
from tickets_api.providers.gate import ProviderGate, RetryPolicy
from tickets_api.providers.serpapi import (
    GOOGLE_FLIGHTS_PREFIX,
    Clock,
    SerpApiFlightProvider,
    _itineraries,
)
from tickets_api.reference.airports import AirportDirectory

DEFAULT_BASE_URL = "https://api.scrape.do"
FLIGHTS_PATH = "/plugin/google/flights"
SCRAPEDO_MAX_CONCURRENCY = 4
# Тайм-аут не повторюємо: невідомо, чи кредити вже списано. Обрив і 502–504 — один раз.
SCRAPEDO_RETRY = RetryPolicy(attempts=2, retry_timeouts=False)
COMBO_LEGS = 5
"""Туди-назад: скільки найдешевших рейсів кожного напрямку поєднуємо (5 × 5 комбінацій)."""


class ScrapeDoFlightProvider(SerpApiFlightProvider):
    name = "scrapedo"

    def __init__(
        self,
        client: httpx.AsyncClient,
        token: str,
        *,
        airports: AirportDirectory,
        max_requests_per_search: int = 2,
        timeout_s: float = 30.0,
        request_timeout_s: float = 20.0,
        market: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        clock: Clock | None = None,
        gate: ProviderGate | None = None,
    ) -> None:
        super().__init__(
            client,
            token,
            airports=airports,
            max_requests_per_search=max_requests_per_search,
            timeout_s=timeout_s,
            request_timeout_s=request_timeout_s,
            market=market,
            base_url=base_url,
            clock=clock,
            gate=gate
            or ProviderGate(
                self.name, max_concurrency=SCRAPEDO_MAX_CONCURRENCY, retry=SCRAPEDO_RETRY
            ),
        )

    async def search(self, query: FlightQuery) -> list[Offer]:
        collected_at = self._clock().replace(microsecond=0)
        there = self._base_params(query)
        back = {**there, "departure_id": there["arrival_id"], "arrival_id": there["departure_id"]}
        left = self._max_requests
        offers: dict[str, Offer] = {}
        for dep, ret in self._date_pairs(query, collected_at.date()):
            # Туди-назад — два запити: без повернення виліт марний.
            cost = 1 if ret is None else 2
            if left < cost:
                break
            left -= cost
            link = _google_flights_link(query, dep, ret)
            if ret is None:
                found = await self._one_way(there, dep, query, link, collected_at)
            else:
                outbound, inbound = await asyncio.gather(
                    self._one_way(there, dep, query, link, collected_at),
                    self._one_way(back, ret, query, link, collected_at),
                )
                found = [
                    _combine(self.name, out, home)
                    for out in outbound[:COMBO_LEGS]
                    for home in inbound[:COMBO_LEGS]
                ]
            for offer in found:
                offers.setdefault(offer.id, offer)
        matches = self._airports.route_filter(query)
        return sorted(filter(matches, offers.values()), key=lambda o: (o.price, o.id))

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Варіантів бронювання scrape.do не віддає (`booking_token` не приймає)."""
        raise ProviderUnsupportedError(self.name, "sellers")

    async def _one_way(
        self,
        params: dict[str, str],
        day: date,
        query: FlightQuery,
        link: str,
        collected_at: datetime,
    ) -> list[Offer]:
        body, _ = await self._get({**params, "type": "2", "outbound_date": day.isoformat()})
        offers = (self._offer(it, None, query, link, collected_at) for it in _itineraries(body))
        return sorted(
            (o.model_copy(update={"booking_ref": None}) for o in offers if o is not None),
            key=lambda o: (o.price, o.id),
        )

    async def _get(self, params: dict[str, str]) -> tuple[dict[str, Any], str | None]:
        body = await scrapedo_get(
            self._client,
            self._gate,
            name=self.name,
            url=f"{self._base_url}{FLIGHTS_PATH}",
            params=params,
            token=self._api_key,
            timeout_s=self._request_timeout_s,
        )
        return body, None


async def scrapedo_get(
    client: httpx.AsyncClient,
    gate: ProviderGate,
    *,
    name: str,
    url: str,
    params: dict[str, str],
    token: str,
    timeout_s: float,
) -> dict[str, Any]:
    """Запит до плагіна scrape.do (перельоти, готелі): токен — лише в query string, у помилках —
    лише статус і тип помилки (URL з токеном і текст джерела туди не потрапляють)."""
    try:
        response = await gate.send(
            lambda: client.get(url, params={**params, "token": token}, timeout=timeout_s)
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(name, "timeout") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(name, f"network error: {type(exc).__name__}") from exc

    if response.status_code in (402, 429):
        raise ProviderRateLimitedError(name, "credits exhausted or rate limited")
    if response.status_code in (401, 403):
        raise ProviderError(name, f"auth failed (HTTP {response.status_code})")
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderError(name, f"invalid JSON (HTTP {response.status_code})") from exc
    if not isinstance(body, dict):
        raise ProviderError(name, "unexpected response")
    if response.status_code != 200 or body.get("error"):
        raise ProviderError(name, f"HTTP {response.status_code}")
    return body


def _combine(source: str, out: Offer, home: Offer) -> Offer:
    """Два квитки в один бік як одна пропозиція туди-назад: ціна — сума, кожен квиток окремо."""
    segments = [s for leg in (out.outbound, home.outbound) for s in leg.segments or []]
    fingerprint = "|".join(f"{s.flight_number}@{s.departure_at.isoformat()}" for s in segments)
    return out.model_copy(
        update={
            "id": hashlib.sha1(f"{source}|2ow|{fingerprint}".encode()).hexdigest()[:16],  # noqa: S324
            "price": out.price + home.price,
            "inbound": home.outbound,
            "airlines": sorted({*out.airlines, *home.airlines}),
            "airline_logos": {**home.airline_logos, **out.airline_logos},
            "separate_tickets": True,
        }
    )


def _google_flights_link(query: FlightQuery, dep: date, ret: date | None) -> str:
    """Та сама видача в Google Flights — пошук за текстом `q` (scrape.do посилання не дає)."""
    text = f"Flights to {query.destination} from {query.origin} on {dep.isoformat()}"
    if ret is not None:
        text += f" through {ret.isoformat()}"
    return f"{GOOGLE_FLIGHTS_PREFIX}?{urlencode({'q': text, 'curr': query.currency, 'hl': 'en'})}"
