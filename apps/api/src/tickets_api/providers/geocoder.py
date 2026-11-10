"""Місце за адресою чи визначною точкою (етап 5, ADR 0049) — OpenStreetMap Nominatim.

Документація: https://nominatim.org/release-docs/latest/api/Search/ ; політика використання:
https://operations.osmfoundation.org/policies/nominatim/ — не частіше 1 запиту на секунду,
User-Agent із контактом, кешування результатів, без автодоповнення на кожну літеру (шукаємо лише
кнопкою), атрибуція «© OpenStreetMap contributors». Звірено з реальною відповіддю (листопад 2026,
tests/fixtures/nominatim/): `lat`/`lon` — рядки, `name`, `display_name`, `category`, `type`.

Запит іде лише з бекенду. Текст запиту (адреса людини) не логуємо; у кеші — лише його хеш.
"""

import asyncio
import hashlib
import time
from typing import Any

import httpx
import structlog
from pydantic import BaseModel, TypeAdapter
from redis.asyncio import Redis
from redis.exceptions import RedisError

log = structlog.get_logger(__name__)

DEFAULT_BASE_URL = "https://nominatim.openstreetmap.org"
SEARCH_PATH = "/search"
MIN_INTERVAL_S = 1.0
"""Політика Nominatim: не частіше 1 запиту на секунду (з усього застосунку)."""
CACHE_TTL_S = 30 * 24 * 3600
CACHE_PREFIX = "geo:v1"
BIAS_DEGREES = 0.3
"""Обмежуємо пошук прямокутником ±0,3° (≈ 30 км) навколо центру міста пошуку житла."""
MAX_RESULTS = 5
SLOT_KEY = "geo:slot"


class GeoPlace(BaseModel):
    name: str
    """Коротка назва (Torre de Belém); без неї — перша частина адреси."""
    label: str
    """Повна адреса з Nominatim (`display_name`)."""
    lat: float
    lon: float
    category: str | None = None


_PLACES = TypeAdapter(list[GeoPlace])


class GeocodeError(Exception):
    pass


class NominatimGeocoder:
    def __init__(
        self,
        client: httpx.AsyncClient,
        redis: Redis | None,
        *,
        user_agent: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 8.0,
    ) -> None:
        self._client = client
        self._redis = redis
        self._user_agent = user_agent
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def search(
        self, text: str, *, center: tuple[float, float] | None, lang: str
    ) -> list[GeoPlace]:
        """Місця за текстом; `center` — центр міста (пошук лише поблизу). Нічого — порожньо."""
        query = " ".join(text.split())[:120]
        key = self._key(query.lower(), center, lang)
        cached = await self._read(key)
        if cached is not None:
            return _PLACES.validate_json(cached)
        params: dict[str, str | int] = {
            "q": query,
            "format": "jsonv2",
            "limit": MAX_RESULTS,
            "accept-language": lang,
        }
        if center is not None:
            lat, lon = center
            d = BIAS_DEGREES
            params["viewbox"] = f"{lon - d},{lat + d},{lon + d},{lat - d}"
            params["bounded"] = 1
        places = _parse(await self._get(params))
        await self._write(key, _PLACES.dump_json(places))
        return places

    async def _get(self, params: dict[str, str | int]) -> Any:
        await self._wait_slot()
        try:
            response = await self._client.get(
                f"{self._base_url}{SEARCH_PATH}",
                params=params,
                headers={"User-Agent": self._user_agent},
                timeout=self._timeout_s,
            )
        except httpx.HTTPError as exc:
            raise GeocodeError(type(exc).__name__) from exc
        if response.status_code != 200:
            raise GeocodeError(f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise GeocodeError("invalid JSON") from exc

    async def _wait_slot(self) -> None:
        """1 запит на секунду: у процесі — замок і пауза; між процесами — слот у Redis."""
        async with self._lock:
            pause = MIN_INTERVAL_S - (time.monotonic() - self._last)
            if pause > 0:
                await asyncio.sleep(pause)
            if self._redis is not None:
                for _ in range(10):
                    try:
                        taken = await self._redis.set(
                            SLOT_KEY, b"1", nx=True, px=int(MIN_INTERVAL_S * 1000)
                        )
                    except RedisError:
                        break  # без Redis — лише обмеження в процесі
                    if taken:
                        break
                    await asyncio.sleep(MIN_INTERVAL_S / 4)
            self._last = time.monotonic()

    def _key(self, query: str, center: tuple[float, float] | None, lang: str) -> str:
        where = f"{center[0]:.2f},{center[1]:.2f}" if center else "-"
        digest = hashlib.sha256(f"{query}|{where}|{lang}".encode()).hexdigest()[:32]
        return f"{CACHE_PREFIX}:{digest}"

    async def _read(self, key: str) -> bytes | None:
        if self._redis is None:
            return None
        try:
            value: bytes | None = await self._redis.get(key)
        except RedisError:
            return None
        return value

    async def _write(self, key: str, value: bytes) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.set(key, value, ex=CACHE_TTL_S)
        except RedisError as exc:
            log.warning("geocoder.cache_write_failed", error=type(exc).__name__)


def _parse(payload: Any) -> list[GeoPlace]:
    places: list[GeoPlace] = []
    for raw in payload if isinstance(payload, list) else []:
        if not isinstance(raw, dict):
            continue
        try:
            lat, lon = float(raw["lat"]), float(raw["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        label = str(raw.get("display_name") or "").strip()
        name = str(raw.get("name") or "").strip() or label.split(",")[0].strip()
        if not name or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        places.append(
            GeoPlace(
                name=name[:120],
                label=(label or name)[:300],
                lat=round(lat, 6),
                lon=round(lon, 6),
                category=str(raw.get("category") or "") or None,
            )
        )
    return places[:MAX_RESULTS]
