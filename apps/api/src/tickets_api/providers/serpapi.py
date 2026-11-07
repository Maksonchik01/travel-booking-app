"""Адаптер Google Flights через SerpApi — ЖИВІ ціни (як на Google Flights у момент запиту).

Документація: https://serpapi.com/google-flights-api. Звірено з реальними відповідями
(листопад 2026, tests/fixtures/serpapi/):
- час сегментів — МІСЦЕВИЙ без поясу ("2026-12-13 06:20"); пояс беремо з довідника
  аеропортів. Без поясу маршрут пропускаємо — не вгадуємо;
- `departure_id`/`arrival_id` приймають кілька аеропортів через кому. Код аеропорту
  шукаємо точно (WAW — лише Шопен, без Модліна), а код міста без власного аеропорту
  розгортаємо в усі аеропорти (LON → LHR,LGW,STN,...);
- туди-назад: перший запит дає вильоти з ціною всієї поїздки, зворотні рейси — окремий
  запит з `departure_token` (+1 запит на кожен виліт). Тому пошук має бюджет запитів;
- ознаки окремих квитків немає → `self_transfer=None`; багажу немає → невідомо;
- `search_metadata.google_flights_url` — посилання на ту саму видачу в Google Flights
  (безкоштовно, без окремого запиту за кожен рейс).

Ключ передається лише в query string (`api_key`), тому в помилки й логи URL не потрапляє.
"""

import asyncio
import hashlib
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import structlog

from tickets_api.domain.flights import (
    Cabin,
    CalendarDay,
    FlightQuery,
    Layover,
    Leg,
    Offer,
    Segment,
)
from tickets_api.domain.sellers import GOOGLE_BOOKING_URL, BookingLink, SellerOffer
from tickets_api.providers.base import ProviderError, ProviderRateLimitedError
from tickets_api.reference.airports import AirportDirectory

log = structlog.get_logger(__name__)

Clock = Callable[[], datetime]

DEFAULT_BASE_URL = "https://serpapi.com"
SEARCH_PATH = "/search.json"
GOOGLE_FLIGHTS_PREFIX = "https://www.google.com/travel/flights"
AIRLINE_LOGO_PREFIX = "https://www.gstatic.com/flights/airline_logos/"
NO_RESULTS_MARKER = "hasn't returned any results"
NIGHT_START, NIGHT_END = time(0, 0), time(6, 0)
TRAVEL_CLASS: dict[Cabin, str] = {
    "economy": "1",
    "premium_economy": "2",
    "business": "3",
    "first": "4",
}


class _Budget:
    def __init__(self, limit: int) -> None:
        self.left = limit

    def take(self) -> bool:
        if self.left <= 0:
            return False
        self.left -= 1
        return True


class SerpApiFlightProvider:
    name = "serpapi"

    def __init__(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        *,
        airports: AirportDirectory,
        max_requests_per_search: int = 4,
        returns_per_date: int = 2,
        timeout_s: float = 30.0,
        request_timeout_s: float = 20.0,
        market: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._airports = airports
        self._max_requests = max_requests_per_search
        self._returns_per_date = returns_per_date
        self.timeout_s = timeout_s  # загальний ліміт для FlightSearchService
        self._request_timeout_s = request_timeout_s
        self._market = market
        self._base_url = base_url.rstrip("/")
        self._clock = clock or (lambda: datetime.now(UTC))

    async def search(self, query: FlightQuery) -> list[Offer]:
        budget = _Budget(self._max_requests)
        collected_at = self._clock().replace(microsecond=0)
        base_params = self._base_params(query)
        offers: dict[str, Offer] = {}
        pairs = self._date_pairs(query, collected_at.date())
        # Конкретні пари з кешованих кандидатів (ADR 0016): бюджет ділимо порівну, щоб
        # перевірити кожну, а не витратити все на першу (туди-назад: виліт + 1 повернення).
        returns_per_date = self._returns_per_date
        if query.check_dates and pairs:
            returns_per_date = max(1, min(returns_per_date, self._max_requests // len(pairs) - 1))
        for dep, ret in pairs:
            if ret is None:
                if not budget.take():
                    break
                body, url = await self._get(
                    {**base_params, "type": "2", "outbound_date": dep.isoformat()}
                )
                for it in _itineraries(body):
                    offer = self._offer(it, None, query, url, collected_at)
                    if offer is not None:
                        offers.setdefault(offer.id, offer)
                continue

            # Виліт без жодного повернення — марний запит: потрібно щонайменше два.
            if budget.left < 2 or not budget.take():
                break
            rt_params = {
                **base_params,
                "type": "1",
                "outbound_date": dep.isoformat(),
                "return_date": ret.isoformat(),
            }
            body, _ = await self._get(rt_params)
            outbound_options = sorted(
                (it for it in _itineraries(body) if it.get("departure_token")),
                key=lambda it: _price(it.get("price")) or Decimal("Infinity"),
            )[:returns_per_date]
            selected = [out for out in outbound_options if budget.take()]
            # Зворотні рейси для кожного вильоту — незалежні запити: паралельно, не по черзі.
            responses = await asyncio.gather(
                *(
                    self._get({**rt_params, "departure_token": o["departure_token"]})
                    for o in selected
                )
            )
            for out, (ret_body, ret_url) in zip(selected, responses, strict=True):
                for back in _itineraries(ret_body):
                    # Ціна у відповіді із зворотними рейсами — за всю поїздку.
                    offer = self._offer(out, back, query, ret_url, collected_at)
                    if offer is not None:
                        offers.setdefault(offer.id, offer)
        # Запит уже обмежено аеропортами, але Google може підмішати сусідні — відсікаємо.
        matches = self._airports.route_filter(query)
        return sorted(filter(matches, offers.values()), key=lambda o: (o.price, o.id))

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Варіанти бронювання (`booking_token`): продавці й їхня ціна зараз — 1 запит квоти.

        Звірено з реальними відповідями (tests/fixtures/serpapi/booking_*.json): кожен варіант —
        `together` з `book_with`, `airline`, `price`, `baggage_prices` і `booking_request`
        (POST на google.com/travel/clk з `post_data`). Окремі квитки туди й назад
        (`departing`/`returning`) у записах не траплялись — їх пропускаємо, а не вгадуємо.
        """
        params = {
            **self._base_params(query),
            "type": "1" if query.return_date else "2",
            "outbound_date": query.departure_date.isoformat(),
            **({"return_date": query.return_date.isoformat()} if query.return_date else {}),
            "booking_token": booking_ref,
        }
        body, _ = await self._get(params)
        checked_at = self._clock().replace(microsecond=0)
        return [
            seller
            for option in body.get("booking_options") or []
            if (seller := _seller(option, query.currency, checked_at)) is not None
        ]

    def _base_params(self, query: FlightQuery) -> dict[str, str]:
        return {
            "departure_id": ",".join(
                self._airports.airports_for(query.origin, query.origin_radius_km)
            ),
            "arrival_id": ",".join(
                self._airports.airports_for(query.destination, query.destination_radius_km)
            ),
            "currency": query.currency,
            "hl": "en",
            # Ціна у відповіді — за весь склад (перевірено фікстурою pax_family.json), тож
            # передаємо склад як є і нічого не множимо (ADR 0013).
            "adults": str(query.passengers.adults),
            **_non_default(
                children=query.passengers.children,
                infants_on_lap=query.passengers.infants,
                infants_in_seat=query.passengers.infants_in_seat,
            ),
            **({"travel_class": TRAVEL_CLASS[query.cabin]} if query.cabin != "economy" else {}),
            **({"stops": "1"} if query.direct_only else {}),
            **({"gl": self._market} if self._market else {}),
        }

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        """Google Flights не дає цін по днях місяця — календар з інших джерел."""
        return []

    # --- внутрішнє -----------------------------------------------------------------

    def _date_pairs(self, query: FlightQuery, today: date) -> list[tuple[date, date | None]]:
        """Дати від запитаної назовні (0, −1, +1, −2, …): бюджет витрачається на найближчі.

        `check_dates` — пари, обрані з кешованих кандидатів; період — дні від початку,
        повернення на ту саму тривалість поїздки.
        """
        if query.check_dates:
            return [(p.departure, p.return_date) for p in query.check_dates if p.departure >= today]
        if query.departure_until is not None:
            start, end = query.departure_window
            length = timedelta(days=query.trip_days or 0)
            return [
                (day, day + length if query.return_date else None)
                for day in (start + timedelta(days=i) for i in range((end - start).days + 1))
                if day >= today
            ]
        shifts = sorted(range(-query.flex_days, query.flex_days + 1), key=lambda s: (abs(s), s))
        pairs = []
        for shift in shifts:
            dep = query.departure_date + timedelta(days=shift)
            ret = query.return_date + timedelta(days=shift) if query.return_date else None
            if dep >= today:  # минулі дати Google не шукає
                pairs.append((dep, ret))
        return pairs

    async def _get(self, params: dict[str, str]) -> tuple[dict[str, Any], str | None]:
        try:
            response = await self._client.get(
                f"{self._base_url}{SEARCH_PATH}",
                params={"engine": "google_flights", **params, "api_key": self._api_key},
                timeout=self._request_timeout_s,
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(self.name, "timeout") from exc
        except httpx.HTTPError as exc:
            # str(exc) може містити URL з ключем — лише тип помилки.
            raise ProviderError(self.name, f"network error: {type(exc).__name__}") from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(self.name, f"invalid JSON (HTTP {response.status_code})") from exc
        if not isinstance(body, dict):
            raise ProviderError(self.name, "unexpected response")

        error = body.get("error")
        if isinstance(error, str) and NO_RESULTS_MARKER in error:
            return {}, None  # нічого не знайдено — це не помилка
        if response.status_code == 429 or (isinstance(error, str) and "run out" in error):
            raise ProviderRateLimitedError(self.name, "search quota exhausted or rate limited")
        if response.status_code in (401, 403):
            raise ProviderError(self.name, f"auth failed (HTTP {response.status_code})")
        if response.status_code != 200 or error:
            raise ProviderError(self.name, f"HTTP {response.status_code}")

        meta = body.get("search_metadata")
        url = meta.get("google_flights_url") if isinstance(meta, dict) else None
        safe_url = url if isinstance(url, str) and url.startswith(GOOGLE_FLIGHTS_PREFIX) else None
        return body, safe_url

    def _offer(
        self,
        out: dict[str, Any],
        back: dict[str, Any] | None,
        query: FlightQuery,
        url: str | None,
        collected_at: datetime,
    ) -> Offer | None:
        price = _price((back or out).get("price"))
        outbound = self._leg(out)
        inbound = self._leg(back) if back is not None else None
        if price is None or outbound is None or (back is not None and inbound is None):
            return None
        if query.direct_only and (outbound.stops or (inbound and inbound.stops)):
            return None
        legs = [outbound, *([inbound] if inbound else [])]
        segments = [s for leg in legs for s in leg.segments or []]
        fingerprint = "|".join(f"{s.flight_number}@{s.departure_at.isoformat()}" for s in segments)
        return Offer(
            id=hashlib.sha1(f"{self.name}|{fingerprint}".encode()).hexdigest()[:16],  # noqa: S324
            source=self.name,
            price=price,
            currency=query.currency,
            outbound=outbound,
            inbound=inbound,
            airlines=sorted({s.carrier for s in segments}),
            airline_logos=_airline_logos([out, *([back] if back else [])]),
            details_level="full",
            baggage_included=None,
            collected_at=collected_at,
            found_at=collected_at,  # живий пошук: ціна актуальна на момент запиту
            deep_link=url,
            price_status="live",
            cabin=query.cabin,
            booking_ref=_booking_token(back or out),
        )

    def _leg(self, itinerary: dict[str, Any]) -> Leg | None:
        try:
            segments = [self._segment(f) for f in itinerary["flights"]]
        except (KeyError, TypeError, ValueError) as exc:
            log.warning("serpapi.bad_segment", error=type(exc).__name__)
            return None
        if not segments or any(s is None for s in segments):
            return None
        segs = [s for s in segments if s is not None]
        raw_layovers = [x if isinstance(x, dict) else {} for x in itinerary.get("layovers") or []]
        layovers = []
        for i, (arriving, leaving) in enumerate(pairwise(segs)):
            raw = raw_layovers[i] if i < len(raw_layovers) else {}
            reported = raw.get("duration")
            duration: int = (
                reported
                if isinstance(reported, int)
                else int((leaving.departure_at - arriving.arrival_at).total_seconds() // 60)
            )
            layovers.append(
                Layover(
                    airport=arriving.destination,
                    duration_min=max(0, duration),
                    overnight=bool(raw.get("overnight"))
                    or _overlaps_local_night(arriving.arrival_at, leaving.departure_at),
                    self_transfer=None,
                )
            )
        total = itinerary.get("total_duration")
        return Leg(
            origin=segs[0].origin,
            destination=segs[-1].destination,
            departure_at=segs[0].departure_at,
            arrival_at=segs[-1].arrival_at,
            duration_min=total if isinstance(total, int) else None,
            stops=len(segs) - 1,
            segments=segs,
            layovers=layovers,
            flight_number=segs[0].flight_number,
        )

    def _segment(self, flight: dict[str, Any]) -> Segment | None:
        dep, arr = flight["departure_airport"], flight["arrival_airport"]
        dep_tz, arr_tz = self._airports.timezone(dep["id"]), self._airports.timezone(arr["id"])
        if dep_tz is None or arr_tz is None:
            log.warning("serpapi.unknown_airport_tz", airports=[dep["id"], arr["id"]])
            return None
        number = str(flight.get("flight_number") or "").replace(" ", "")
        carrier = str(flight.get("flight_number") or "").split(" ")[0] or "?"
        return Segment(
            origin=dep["id"],
            destination=arr["id"],
            departure_at=_local(dep["time"], dep_tz),
            arrival_at=_local(arr["time"], arr_tz),
            carrier=carrier,
            flight_number=number or "?",
            duration_min=int(flight["duration"]),
        )


def _airline_logos(itineraries: list[dict[str, Any]]) -> dict[str, str]:
    """`flights[].airline_logo` за кодом перевізника. Інші хости відкидаємо: дані недовірені,
    а UI вантажить картинки через свій сервер лише з дозволених адрес."""
    logos: dict[str, str] = {}
    for itinerary in itineraries:
        for flight in itinerary.get("flights") or []:
            if not isinstance(flight, dict):
                continue
            logo = flight.get("airline_logo")
            carrier = str(flight.get("flight_number") or "").split(" ")[0]
            if carrier and isinstance(logo, str) and logo.startswith(AIRLINE_LOGO_PREFIX):
                logos.setdefault(carrier, logo)
    return logos


def _itineraries(body: dict[str, Any]) -> list[dict[str, Any]]:
    items = [*(body.get("best_flights") or []), *(body.get("other_flights") or [])]
    return [it for it in items if isinstance(it, dict) and isinstance(it.get("flights"), list)]


def _local(value: str, tz: ZoneInfo) -> datetime:
    """ "2026-12-13 06:20" (місцевий час аеропорту) → datetime з поясом аеропорту."""
    return datetime.strptime(value, "%Y-%m-%d %H:%M").replace(tzinfo=tz)


def _overlaps_local_night(start: datetime, end: datetime) -> bool:
    """Чи зачіпає інтервал 00:00–06:00 за місцевим часом (обидва моменти — в одному аеропорту)."""
    start_local, end_local = (
        start.replace(tzinfo=None),
        end.astimezone(start.tzinfo).replace(tzinfo=None),
    )
    day = start_local.date()
    while day <= end_local.date():
        if start_local < datetime.combine(day, NIGHT_END) and end_local > datetime.combine(
            day, NIGHT_START
        ):
            return True
        day += timedelta(days=1)
    return False


def _price(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        price = Decimal(str(value))
    except InvalidOperation:
        return None
    return price if price > 0 else None


def _non_default(**counts: int) -> dict[str, str]:
    """Лише ненульові лічильники: типові значення SerpApi — 0, запит лишається коротшим."""
    return {name: str(n) for name, n in counts.items() if n}


def _booking_token(itinerary: dict[str, Any]) -> str | None:
    """Токен варіантів бронювання (продавці й свіжа ціна) — для туди-назад з відповіді із
    поверненнями (там ціна всієї поїздки)."""
    token = itinerary.get("booking_token")
    return token if isinstance(token, str) and 0 < len(token) <= 4096 else None


def _seller(option: Any, currency: str, checked_at: datetime) -> SellerOffer | None:
    together = option.get("together") if isinstance(option, dict) else None
    if not isinstance(together, dict):
        return None
    price = _price(together.get("price"))
    name = together.get("book_with")
    if price is None or not isinstance(name, str) or not name:
        return None
    included = [b for b in together.get("baggage_prices") or [] if isinstance(b, str)]
    request = together.get("booking_request")
    link = None
    if (
        isinstance(request, dict)
        and request.get("url") == GOOGLE_BOOKING_URL
        and isinstance(request.get("post_data"), str)
    ):
        link = BookingLink(url=GOOGLE_BOOKING_URL, method="POST", post_data=request["post_data"])
    return SellerOffer(
        seller=name,
        is_airline=together.get("airline") is True,
        price=price,
        currency=currency,
        included=included,
        fare_name=together.get("option_title")
        if isinstance(together.get("option_title"), str)
        else None,
        link=link,
        checked_at=checked_at,
    )
