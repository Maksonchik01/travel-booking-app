"""Житло з Google Hotels через scrape.do — фото, опис, рейтинг і ціни продавців (ADR 0044).

Документація: https://scrape.do/documentation/google-scraper-api/hotels/. Звірено з реальними
відповідями (листопад 2026, tests/fixtures/scrapedo/hotels_*.json):
- пошук `GET /plugin/google/hotels` (`q` — "<місто> hotels", дати, валюта) — до 20 об'єктів:
  `name`, `description` (не завжди), `gps_coordinates`, `extracted_hotel_class`, `overall_rating`
  (0–5), `reviews`, `images[]` (lh3.googleusercontent.com), `check_in_time`/`check_out_time`,
  `price` (за ніч) і `total_rate` (за весь період), `detail_token`;
- продавці `GET /plugin/google/hotels/detail` (`detail_token`) — `booking_sources[]`: назва, ціна
  за ніч і за весь період, `click` (відносне посилання google.com), `sponsored`. Типів номерів,
  харчування й умов скасування немає — у тарифі вони невідомі (None), а не вигадані;
- ціни Google Hotels — завжди на ДВОХ дорослих в одному номері (параметрів складу немає). Тож
  приймаємо 1–2 дорослих без дітей в одному номері (на одного — ціна номера на двох, не нижча
  за справжню), інший склад — `ProviderUnsupportedError("guests")` (ціну не вигадуємо);
- чи податки в ціні, джерело не каже: `taxes_included=None` → кінцеву суму підтверджує продавець;
- коди зручностей (`amenities`) не документовані — не вгадуємо, лишаємо порожньо;
- посилання «на сайт» у пошуку немає → пошук готелю за назвою в Google Hotels.

Кожен запит — 10 кредитів scrape.do: пошук і тарифи кешуються (`CachedStayProvider`), а тарифи
беруть `detail_token` з кешу пошуку (`lookup`), а не новим пошуком.
"""

import hashlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

import httpx

from tickets_api.domain.money import to_cents
from tickets_api.domain.stay_rates import StayRate
from tickets_api.domain.stays import Stay, StayKind, StayQuery, StayReview
from tickets_api.providers.base import ProviderUnsupportedError
from tickets_api.providers.budget import ApiMeter
from tickets_api.providers.gate import ProviderGate
from tickets_api.providers.scrapedo import (
    DEFAULT_BASE_URL,
    SCRAPEDO_MAX_CONCURRENCY,
    SCRAPEDO_RETRY,
    scrapedo_get,
)
from tickets_api.reference.airports import AirportDirectory, distance_km

Clock = Callable[[], datetime]
Lookup = Callable[[StayQuery], Awaitable[list[Stay]]]

HOTELS_PATH = "/plugin/google/hotels"
DETAIL_PATH = "/plugin/google/hotels/detail"
GOOGLE = "https://www.google.com"
GOOGLE_HOTELS_SEARCH = f"{GOOGLE}/travel/search"
CLICK_PATHS = ("/travel/lodging/clk?", "/aclk?")
"""Посилання продавців — лише на ці шляхи google.com (решту відкидаємо: дані недовірені)."""
PHOTO_PREFIX = "https://lh3.googleusercontent.com/"
PHOTO_LARGE = "=w1280-h853-k-no"
"""Розмір фото для сторінки об'єкта (у відповіді — мініатюри 287×192, параметр після «=»)."""
MAX_PHOTOS = 12
KIND: dict[str, StayKind] = {"hotel": "hotel", "vacation rental": "apartment"}


class ScrapeDoStayProvider:
    name = "scrapedo"

    def __init__(
        self,
        client: httpx.AsyncClient,
        token: str,
        *,
        airports: AirportDirectory,
        timeout_s: float = 30.0,
        request_timeout_s: float = 25.0,
        market: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        clock: Clock | None = None,
        gate: ProviderGate | None = None,
        meter: ApiMeter | None = None,
    ) -> None:
        self._client = client
        self._token = token
        self._airports = airports
        self.timeout_s = timeout_s
        self._request_timeout_s = request_timeout_s
        self._market = market
        self._base_url = base_url.rstrip("/")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._gate = gate or ProviderGate(
            self.name, max_concurrency=SCRAPEDO_MAX_CONCURRENCY, retry=SCRAPEDO_RETRY, meter=meter
        )
        self.lookup: Lookup = self.search
        """Звідки тарифи беруть об'єкт: реєстр підставляє кешований пошук (без нового запиту)."""

    async def search(self, query: StayQuery) -> list[Stay]:
        guests = query.guests
        if guests.adults > 2 or guests.children or guests.rooms != 1:
            raise ProviderUnsupportedError(self.name, "guests")
        city = self._airports.city_of(query.city)
        if city is None:
            return []
        body = await self._get(HOTELS_PATH, {"q": f"{city.name} hotels", **self._dates(query)})
        now = self._clock().replace(microsecond=0)
        stays: dict[str, Stay] = {}
        for item in body.get("properties") or []:
            if not isinstance(item, dict):
                continue
            stay = self._stay(item, query, (city.lat, city.lon), city.name, now)
            if stay is not None:
                stays.setdefault(stay.id, stay)
        return list(stays.values())

    async def rates(self, query: StayQuery, stay_id: str) -> list[StayRate]:
        stay = next((s for s in await self.lookup(query) if s.id == stay_id), None)
        if stay is None:
            return []
        if stay.booking_ref is None:
            raise ProviderUnsupportedError(self.name, "rates")
        body = await self._get(
            DETAIL_PATH, {"detail_token": stay.booking_ref, **self._dates(query)}
        )
        prop = body.get("property")
        sources = prop.get("booking_sources") if isinstance(prop, dict) else None
        checked_at = self._clock().replace(microsecond=0)
        rates = []
        for source in sources or []:
            rate = _rate(source, stay, query, checked_at)
            if rate is not None:
                rates.append(rate)
        return rates

    async def reviews(self, stay_id: str, *, limit: int = 30) -> list[StayReview]:
        """Текстів відгуків джерело не дає — лише кількість і оцінку."""
        return []

    def _dates(self, query: StayQuery) -> dict[str, str]:
        return {
            "check_in_date": query.check_in.isoformat(),
            "check_out_date": query.check_out.isoformat(),
            "currency": query.currency,
            "hl": "en",
            **({"gl": self._market} if self._market else {}),
        }

    async def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        return await scrapedo_get(
            self._client,
            self._gate,
            name=self.name,
            url=f"{self._base_url}{path}",
            params=params,
            token=self._token,
            timeout_s=self._request_timeout_s,
            operation="hotels" if path == HOTELS_PATH else "hotel_rates",
        )

    def _stay(
        self,
        item: dict[str, Any],
        query: StayQuery,
        center: tuple[float, float],
        city_name: str,
        now: datetime,
    ) -> Stay | None:
        name = item.get("name")
        gps = item.get("gps_coordinates")
        if not isinstance(name, str) or not name.strip() or not isinstance(gps, dict):
            return None
        lat, lon = gps.get("latitude"), gps.get("longitude")
        if not isinstance(lat, int | float) or not isinstance(lon, int | float):
            return None
        total = _amount(item.get("total_rate"), query.currency)
        per_night = _amount(item.get("price"), query.currency)
        if total is None:
            if per_night is None:
                return None  # без ціни на ці дати — не пропозиція
            total = to_cents(per_night * query.nights)
        if per_night is None:
            per_night = to_cents(total / query.nights)
        rating = item.get("overall_rating")
        stars = item.get("extracted_hotel_class")
        reviews = item.get("reviews")
        photos = _photos(item.get("images"))
        token = item.get("detail_token")
        description = item.get("description")
        digest = hashlib.sha1(f"{name}|{lat:.5f}|{lon:.5f}".encode()).hexdigest()[:12]  # noqa: S324
        return Stay(
            id=f"gh-{digest}",
            source=self.name,
            name=name.strip(),
            kind=KIND.get(str(item.get("type")), "other"),
            stars=stars if isinstance(stars, int) and 1 <= stars <= 5 else None,
            price_per_night=per_night,
            total_price=total,
            taxes_included=None,
            currency=query.currency,
            nights=query.nights,
            # Google — 0–5, у нас 0–10.
            rating=round(Decimal(str(rating)) * 2, 1)
            if isinstance(rating, int | float) and 0 <= rating <= 5
            else None,
            review_count=reviews if isinstance(reviews, int) and reviews >= 0 else 0,
            latitude=round(float(lat), 5),
            longitude=round(float(lon), 5),
            distance_to_center_km=Decimal(str(round(distance_km(center, (lat, lon)), 1))),
            image_url=photos[0][0] if photos else None,
            images=[large for _, large in photos],
            description=description.strip()[:2000]
            if isinstance(description, str) and description.strip()
            else None,
            check_in_time=_short(item.get("check_in_time")),
            check_out_time=_short(item.get("check_out_time")),
            booking_ref=token if isinstance(token, str) and 0 < len(token) <= 4096 else None,
            deep_link=_hotel_link(name.strip(), city_name, query.currency),
            collected_at=now,
            found_at=now,
        )


def _amount(price: Any, currency: str) -> Decimal | None:
    """Об'єкт ціни {amount, currency}; інша валюта, ніж у запиті, — не наша ціна."""
    if not isinstance(price, dict) or price.get("currency") != currency:
        return None
    value = price.get("amount")
    if not isinstance(value, int | float) or isinstance(value, bool):
        return None
    try:
        amount = to_cents(Decimal(str(value)))
    except InvalidOperation:
        return None
    return amount if amount > 0 else None


def _photos(images: Any) -> list[tuple[str, str]]:
    """(мініатюра, велике) — лише з хоста фото Google."""
    result = []
    for image in images if isinstance(images, list) else []:
        thumb = image.get("thumbnail") if isinstance(image, dict) else None
        if isinstance(thumb, str) and thumb.startswith(PHOTO_PREFIX):
            result.append((thumb, thumb.split("=", 1)[0] + PHOTO_LARGE))
    return result[:MAX_PHOTOS]


def _short(value: Any) -> str | None:
    """Час "3:00\u202fPM" — з вузьким нерозривним пробілом; у нас звичайний."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.replace("\u202f", " ").replace("\xa0", " ").split())
    return text if 0 < len(text) <= 20 else None


def _hotel_link(name: str, city: str, currency: str) -> str:
    return (
        f"{GOOGLE_HOTELS_SEARCH}?{urlencode({'q': f'{name} {city}', 'hl': 'en', 'curr': currency})}"
    )


def _rate(source: Any, stay: Stay, query: StayQuery, checked_at: datetime) -> StayRate | None:
    if not isinstance(source, dict):
        return None
    seller = source.get("name")
    total = _amount(source.get("total_rate"), query.currency)
    if not isinstance(seller, str) or not seller.strip() or total is None:
        return None
    click = source.get("click")
    link = (
        f"{GOOGLE}{click}"
        if isinstance(click, str) and click.startswith(CLICK_PATHS) and len(click) <= 2048
        else None
    )
    return StayRate(
        seller=seller.strip(),
        is_property=seller.strip().casefold() == stay.name.casefold(),
        room_name="",  # джерело не називає номер: UI пише «номер на двох, тип — у продавця»
        price_total=total,
        currency=query.currency,
        deep_link=link,
        sponsored=source.get("sponsored") is True,
        checked_at=checked_at,
    )
