"""Адаптер Travelpayouts / Aviasales Data API.

Важливо: це КЕШОВАНІ ціни з історії пошуків користувачів Aviasales, а не живі тарифи.
Посегментних даних API не дає — лише кількість пересадок і тривалість, тому
пропозиції мають details_level="summary", а layovers=None («деталі невідомі»).

Звірено з реальними відповідями (листопад 2026, tests/fixtures/travelpayouts/):
- `origin`/`destination` — код МІСТА із запиту, `origin_airport`/`destination_airport` —
  фактичний аеропорт вильоту (WAW-запит дає і WAW, і WMI/Модлін);
- `gate` — продавець квитка (напр. Kiwi.com);
- `duration_to`/`duration_back` — лише час У ПОВІТРІ, `duration` — повний час у дорозі
  разом з пересадками (рейс з 1 пересадкою: duration_to=295, duration=3995). Наземний
  час = duration − duration_to − duration_back; приписуємо його напрямку, лише якщо
  пересадки є тільки в одному з них, інакше по напрямках — невідомо, загальний — відомий;
- `expires_at` і часу знаходження ціни у відповіді немає. Посилання `link` містить
  недокументований параметр `search_date=DDMMYYYY`; на реальних даних це день, коли ціну
  знайдено (0–6 днів тому, `expected_price` у посиланні = `price`). Беремо лише день.

Ендпоінти (https://support.travelpayouts.com/hc/en-us/articles/203956163):
- GET /aviasales/v3/prices_for_dates — квитки на дату (YYYY-MM-DD) або місяць (YYYY-MM);
- GET /aviasales/v3/grouped_prices   — найдешевші ціни, згруповані по днях.
Автентифікація — заголовок X-Access-Token.
"""

import hashlib
import re
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

import httpx
import structlog

from tickets_api.domain.flights import CalendarDay, FlightQuery, Leg, Offer
from tickets_api.providers.base import (
    ProviderError,
    ProviderRateLimitedError,
    ProviderUnsupportedError,
)
from tickets_api.reference.airports import AirportDirectory

log = structlog.get_logger(__name__)

Clock = Callable[[], datetime]

DEFAULT_BASE_URL = "https://api.travelpayouts.com"
BOOKING_HOST = "https://www.aviasales.com"
PRICES_FOR_DATES = "/aviasales/v3/prices_for_dates"
GROUPED_PRICES = "/aviasales/v3/grouped_prices"
MAX_LIMIT = 100


class TravelpayoutsFlightProvider:
    name = "travelpayouts"

    def __init__(
        self,
        client: httpx.AsyncClient,
        token: str,
        *,
        marker: str | None = None,
        airports: AirportDirectory | None = None,
        base_url: str = DEFAULT_BASE_URL,
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self._token = token
        # API шукає по МІСТУ (WAW дає і Модлін); з довідником лишаємо лише обрані аеропорти.
        self._airports = airports
        self._marker = marker
        self._base_url = base_url.rstrip("/")
        self._clock = clock or (lambda: datetime.now(UTC))

    async def search(self, query: FlightQuery) -> list[Offer]:
        # Кешовані ціни — лише за одного дорослого в економі. Дорослих множимо (тариф той
        # самий), а дітей і немовлят — ні: їхній тариф інший і невідомий (ADR 0013).
        if not query.passengers.adults_only:
            raise ProviderUnsupportedError(self.name, "passengers")
        if query.cabin != "economy":
            raise ProviderUnsupportedError(self.name, "cabin")
        adults = query.passengers.adults
        dep_from, dep_to = query.departure_window
        ret_window = query.return_window
        offers: dict[str, Offer] = {}
        matches = self._airports.route_filter(query) if self._airports else None
        # Без гнучкості — точна дата; з гнучкістю — запит на місяць(і) і фільтр по вікну.
        # Так замість 2N+1 запитів робимо 1–2.
        for departure_at, return_at in self._date_params(query):
            params: dict[str, str | int] = {
                "origin": query.origin,
                "destination": query.destination,
                "departure_at": departure_at,
                "currency": query.currency.lower(),
                "sorting": "price",
                "limit": MAX_LIMIT,
                "one_way": "false" if query.return_date else "true",
            }
            if return_at is not None:
                params["return_at"] = return_at
            if query.direct_only:
                params["direct"] = "true"
            payload = await self._get(PRICES_FOR_DATES, params)
            collected_at = self._clock().replace(microsecond=0)
            currency = str(payload.get("currency") or query.currency).upper()
            for raw in _as_list(payload.get("data")):
                offer = self._to_offer(raw, currency, collected_at, query.return_date is not None)
                if offer is None:
                    continue
                if not _within(offer.outbound.departure_at.date(), (dep_from, dep_to)):
                    continue
                if offer.inbound and not _within(offer.inbound.departure_at.date(), ret_window):
                    continue
                if query.direct_only and offer.stops > 0:
                    continue
                if matches is not None and not matches(offer):
                    continue
                if adults > 1:
                    offer = offer.model_copy(update={"price": offer.price * adults})
                offers.setdefault(offer.id, offer)
        return sorted(offers.values(), key=lambda o: (o.price, o.id))

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        payload = await self._get(
            GROUPED_PRICES,
            {
                "origin": origin.upper(),
                "destination": destination.upper(),
                "departure_at": month.strftime("%Y-%m"),
                "currency": currency.lower(),
                "group_by": "departure_at",
            },
        )
        collected_at = self._clock().replace(microsecond=0)
        resp_currency = str(payload.get("currency") or currency).upper()
        data = payload.get("data")
        days: list[CalendarDay] = []
        for key, raw in data.items() if isinstance(data, dict) else []:
            day = _parse_date(key)
            price = _parse_price(raw.get("price") if isinstance(raw, dict) else None)
            if day is None or price is None or (day.year, day.month) != (month.year, month.month):
                continue
            days.append(
                CalendarDay(
                    date=day,
                    price=price,
                    currency=resp_currency,
                    stops=_parse_int(raw.get("transfers")),
                    airline=raw.get("airline") or None,
                    source=self.name,
                    collected_at=collected_at,
                    found_on=_search_date(raw.get("link")),
                )
            )
        return sorted(days, key=lambda d: d.date)

    # --- внутрішнє -----------------------------------------------------------------

    def _date_params(self, query: FlightQuery) -> list[tuple[str, str | None]]:
        if not query.is_flexible:
            ret = query.return_date.isoformat() if query.return_date else None
            return [(query.departure_date.isoformat(), ret)]
        dep_months = _months_between(*query.departure_window)
        ret_window = query.return_window
        ret_months = _months_between(*ret_window) if ret_window else [None]
        return [(d, r) for d in dep_months for r in ret_months]

    async def _get(self, path: str, params: dict[str, str | int]) -> dict[str, Any]:
        try:
            response = await self._client.get(
                f"{self._base_url}{path}",
                params=params,
                headers={"X-Access-Token": self._token, "Accept-Encoding": "gzip"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(self.name, "timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, f"network error: {type(exc).__name__}") from exc

        # Тіло відповіді в помилку не кладемо: воно може містити відлуння заголовків.
        if response.status_code == 429:
            raise ProviderRateLimitedError(self.name, "rate limited (HTTP 429)")
        if response.status_code in (401, 403):
            raise ProviderError(self.name, f"auth failed (HTTP {response.status_code})")
        if response.status_code != 200:
            raise ProviderError(self.name, f"HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError(self.name, "invalid JSON") from exc
        if not isinstance(payload, dict) or payload.get("success") is False:
            raise ProviderError(self.name, "unsuccessful response")
        return payload

    def _to_offer(
        self, raw: Any, currency: str, collected_at: datetime, round_trip: bool
    ) -> Offer | None:
        """Один рядок `data` → Offer. Невалідні рядки пропускаємо, а не валимо весь пошук."""
        if not isinstance(raw, dict):
            return None
        try:
            origin, destination = str(raw["origin"]), str(raw["destination"])
            price = _parse_price(raw.get("price"))
            departure_at = _parse_datetime(raw.get("departure_at"))
            if price is None or departure_at is None:
                return None
            airline = str(raw.get("airline") or "") or None
            # Фактичні аеропорти відомі лише для вильоту туди; для зворотного напрямку
            # API їх не дає, тож там лишаємо коди міст, а не вгадуємо.
            dep_airport = str(raw.get("origin_airport") or origin)
            arr_airport = str(raw.get("destination_airport") or destination)
            flight_number = raw.get("flight_number")
            flight = f"{airline or ''}{flight_number}" if flight_number not in (None, "") else None
            return_at = _parse_datetime(raw.get("return_at"))
            if round_trip and return_at is None:
                return None
            stops_out = _parse_int(raw.get("transfers")) or 0
            stops_back = (_parse_int(raw.get("return_transfers")) or 0) if round_trip else 0
            total = _parse_int(raw.get("duration"))
            out_min, back_min = _leg_durations(
                total,
                _parse_int(raw.get("duration_to")),
                _parse_int(raw.get("duration_back")) if round_trip else 0,
                stops_out,
                stops_back,
            )
            outbound = Leg(
                origin=dep_airport,
                destination=arr_airport,
                departure_at=departure_at,
                duration_min=out_min,
                stops=stops_out,
                flight_number=flight,
            )
            inbound = None
            if round_trip and return_at is not None:
                inbound = Leg(
                    origin=destination,
                    destination=origin,
                    departure_at=return_at,
                    duration_min=back_min,
                    stops=stops_back,
                )
            link = raw.get("link")
            offer_id = hashlib.sha1(  # noqa: S324 — не криптографія, лише стабільний id
                f"{self.name}|{origin}|{destination}|{departure_at}|{return_at}|{flight}|{price}".encode()
            ).hexdigest()[:16]
            return Offer(
                id=offer_id,
                source=self.name,
                price=price,
                currency=currency,
                outbound=outbound,
                inbound=inbound,
                airlines=[airline] if airline else [],
                details_level="summary",
                collected_at=collected_at,
                found_on=_search_date(link),
                expires_at=_parse_datetime(raw.get("expires_at")),
                deep_link=self._deep_link(link),
                seller=str(raw.get("gate") or "") or None,
                price_status="cached",
                cabin="economy",
                reported_total_duration_min=total,
            )
        except (KeyError, ValueError, TypeError) as exc:
            log.warning("travelpayouts.bad_row", error=type(exc).__name__)
            return None

    def _deep_link(self, link: Any) -> str | None:
        # API дає відносний шлях. Будь-що, що не починається з одного "/", могло б
        # підмінити хост ("@evil.example/..." або "//evil.example"), тож відкидаємо.
        if not isinstance(link, str) or not link.startswith("/") or link.startswith("//"):
            return None
        url = f"{BOOKING_HOST}{link}"
        if self._marker:
            url += ("&" if "?" in link else "?") + urlencode({"marker": self._marker})
        return url


def _leg_durations(
    total: int | None, air_to: int | None, air_back: int | None, stops_to: int, stops_back: int
) -> tuple[int | None, int | None]:
    """Повний час кожного напрямку з урахуванням наземного часу на пересадках.

    Без пересадок час у повітрі = час у дорозі. Наземний час (total − повітря) можна
    приписати напрямку, лише якщо пересадки є тільки в ньому; інакше — None (невідомо).
    """
    ground = None
    if total is not None and air_to is not None and air_back is not None:
        ground = total - air_to - air_back
        if ground < 0:
            ground = None
    out = air_to if stops_to == 0 else None
    back = air_back if stops_back == 0 else None
    if ground is not None:
        if stops_to > 0 and stops_back == 0 and air_to is not None:
            out = air_to + ground
        elif stops_back > 0 and stops_to == 0 and air_back is not None:
            back = air_back + ground
    return out, back


_SEARCH_DATE = re.compile(r"[?&]search_date=(\d{2})(\d{2})(\d{4})(?:&|$)")


def _search_date(link: Any) -> date | None:
    """День знаходження ціни з `search_date=DDMMYYYY` у посиланні (недокументовано)."""
    if not isinstance(link, str):
        return None
    match = _SEARCH_DATE.search(link)
    if match is None:
        return None
    day, month, year = (int(g) for g in match.groups())
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _within(day: date, window: tuple[date, date] | None) -> bool:
    return window is None or window[0] <= day <= window[1]


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _months_between(start: date, end: date) -> list[str]:
    months = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        months.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def _parse_price(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        price = Decimal(str(value))
    except InvalidOperation:
        return None
    return price if price > 0 else None


def _parse_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_datetime(value: Any) -> datetime | None:
    """ISO 8601 з поясом ("2026-10-19T03:10:00+03:00" або "...Z"). Без поясу — None:
    вгадувати пояс аеропорту не будемо."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None
