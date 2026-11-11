"""Навантажувальний тест SkyPack (V3, етап 8) — ізольовано, без жодного платного запиту.

Піднімає:
- **фейкові джерела** (127.0.0.1:8299) — SerpApi, scrape.do (перельоти, Google Hotels) і
  Travelpayouts віддають ЗАПИСАНІ відповіді з `apps/api/tests/fixtures/` із затримкою 0,3–1 с і
  рахують кожен виклик;
- **API** (127.0.0.1:8298) — справжні адаптери, `ProviderGate`, бюджет, кеш, ліміти; адреси джерел
  ведуть на фейкові, ключі — фіктивні, `.env` не читається (робоча тека — тимчасова), Redis —
  окрема база 14 (очищається перед кожним сценарієм), Postgres — локальний з docker compose.

Сценарії: змішане навантаження, однакові одночасні запити, вичерпаний бюджет, ліміт запитів,
ліміт одночасних пошуків, читання з бази. Результат — markdown у stdout.

    uv run python scripts/load_test.py            # потрібні docker compose Postgres і Redis
"""

import asyncio
import contextlib
import json
import os
import random
import statistics
import subprocess
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from redis.asyncio import Redis
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "apps/api/tests/fixtures"
FAKE_PORT, API_PORT = 8299, 8298
FAKE = f"http://127.0.0.1:{FAKE_PORT}"
API = f"http://127.0.0.1:{API_PORT}"
REDIS_URL = "redis://localhost:6379/14"
DATABASE_URL = "postgresql+asyncpg://tickets:tickets@localhost:5432/tickets"
INTERNAL_KEY = "load-test-internal-key-not-a-secret"
LATENCY = (0.3, 1.0)

calls: Counter[str] = Counter()


def fixture(path: str) -> Any:
    body = json.loads((FIXTURES / path).read_text())
    if isinstance(body, dict):
        body.pop("_meta", None)
    return body


async def _wait() -> None:
    await asyncio.sleep(random.uniform(*LATENCY))  # noqa: S311 — затримка тесту, не криптографія


async def serpapi(request: Request) -> JSONResponse:
    calls["serpapi"] += 1
    await _wait()
    return JSONResponse(fixture("serpapi/oneway.json"))


async def scrapedo_flights(request: Request) -> JSONResponse:
    calls["scrapedo:flights"] += 1
    await _wait()
    p = request.query_params
    name = f"one_way_{p['departure_id']}_{p['arrival_id']}_{p['outbound_date']}".lower()
    path = FIXTURES / "scrapedo" / f"{name}.json"
    return JSONResponse(fixture(f"scrapedo/{name}.json") if path.exists() else {})


async def scrapedo_hotels(request: Request) -> JSONResponse:
    calls["scrapedo:hotels"] += 1
    await _wait()
    return JSONResponse(fixture("scrapedo/hotels_lis_2026-12-13.json"))


async def scrapedo_detail(request: Request) -> JSONResponse:
    calls["scrapedo:hotel_rates"] += 1
    await _wait()
    return JSONResponse(fixture("scrapedo/hotel_detail_lis_0.json"))


async def travelpayouts(request: Request) -> JSONResponse:
    calls["travelpayouts"] += 1
    await _wait()
    p = request.query_params
    if "destination" in p:
        return JSONResponse(fixture("travelpayouts/prices_for_dates_rt.json"))
    unique = "true" if p.get("unique") == "true" else "false"
    return JSONResponse(fixture(f"travelpayouts/explore_ams_2026-12_unique_{unique}.json"))


fake_app = Starlette(
    routes=[
        Route("/search.json", serpapi),
        Route("/plugin/google/flights", scrapedo_flights),
        Route("/plugin/google/hotels", scrapedo_hotels),
        Route("/plugin/google/hotels/detail", scrapedo_detail),
        Route("/aviasales/v3/prices_for_dates", travelpayouts),
    ]
)


def api_env(**overrides: str) -> dict[str, str]:
    env = {
        "PATH": os.environ["PATH"],
        "APP_ENV": "development",
        "LOG_LEVEL": "WARNING",
        "DATABASE_URL": DATABASE_URL,
        "REDIS_URL": REDIS_URL,
        "INTERNAL_API_KEY": INTERNAL_KEY,
        "FLIGHT_PROVIDERS": "serpapi,scrapedo,travelpayouts",
        "CALENDAR_PROVIDERS": "travelpayouts",
        "STAY_PROVIDERS": "scrapedo",
        "ALERT_PROVIDERS": "mock",
        "LLM_PROVIDER": "off",
        "SENTRY_DSN": "",
        "SERPAPI_KEY": "fake",
        "SCRAPEDO_TOKEN": "fake",
        "TRAVELPAYOUTS_TOKEN": "fake",
        "SERPAPI_BASE_URL": FAKE,
        "SCRAPEDO_BASE_URL": FAKE,
        "TRAVELPAYOUTS_BASE_URL": FAKE,
        "GEOCODER_BASE_URL": FAKE,
        "DEEPSEEK_BASE_URL": FAKE,
        # Ліміти — з запасом: сценарії лімітів задають свої.
        "RATE_LIMIT_SEARCH_PER_HOUR": "100000",
        "RATE_LIMIT_HEAVY_PER_HOUR": "100000",
        "RATE_LIMIT_LOOKUP_PER_HOUR": "100000",
        "MAX_CONCURRENT_SEARCHES": "20",
        "SERPAPI_BUDGET_HOURLY": "",
        "SERPAPI_BUDGET_DAILY": "",
        "SERPAPI_BUDGET_MONTHLY": "",
        "SCRAPEDO_BUDGET_HOURLY": "",
        "SCRAPEDO_BUDGET_DAILY": "",
        "SCRAPEDO_BUDGET_MONTHLY": "",
    }
    env.update(overrides)
    return env


class ApiProcess:
    def __init__(self, **env: str) -> None:
        self.env = api_env(**env)
        self.proc: subprocess.Popen[bytes] | None = None
        self.workdir = tempfile.TemporaryDirectory()  # без .env: справжні ключі не підхопляться

    async def __aenter__(self) -> "ApiProcess":
        self.proc = subprocess.Popen(  # noqa: S603, ASYNC220 — фіксована команда, разовий старт
            [
                sys.executable,
                "-m",
                "uvicorn",
                "tickets_api.asgi:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(API_PORT),
                "--log-level",
                "warning",
            ],
            cwd=self.workdir.name,
            env=self.env,
        )
        async with httpx.AsyncClient() as client:
            for _ in range(100):
                with contextlib.suppress(httpx.HTTPError):
                    if (await client.get(f"{API}/health")).status_code == 200:
                        return self
                await asyncio.sleep(0.2)
        raise RuntimeError("API не стартував")

    async def __aexit__(self, *exc: object) -> None:
        if self.proc is None:
            return
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self.workdir.cleanup()


async def flush() -> None:
    redis = Redis.from_url(REDIS_URL)
    await redis.flushdb()
    await redis.aclose()
    calls.clear()


def flight(adults: int = 1, *, back: bool = False, direct: bool = False) -> dict[str, Any]:
    body: dict[str, Any] = {
        "origin": "WAW",
        "destination": "LIS",
        "departure_date": "2026-12-13",
        "passengers": {"adults": adults},
        "direct_only": direct,
    }
    if back:
        body["return_date"] = "2026-12-20"
    return body


def stay(adults: int = 1) -> dict[str, Any]:
    return {
        "city": "LIS",
        "check_in": "2026-12-13",
        "check_out": "2026-12-16",
        "guests": {"adults": adults},
    }


EXPLORE = {
    "origins": ["AMS"],
    "departure_date": "2026-12-01",
    "departure_until": "2026-12-31",
    "min_nights": 2,
    "max_nights": 4,
}
MIX: list[tuple[str, str, dict[str, Any]]] = [
    *[("flights", "/flights/search", flight(a)) for a in (1, 2, 3)],
    *[("flights", "/flights/search", flight(a, back=True)) for a in (1, 2)],
    ("flights", "/flights/search", flight(1, direct=True)),
    *[("stays", "/stays/search", stay(a)) for a in (1, 2)],
    ("explore", "/explore", EXPLORE),
]


def headers(ip: str) -> dict[str, str]:
    return {"x-client-ip": ip, "x-internal-key": INTERNAL_KEY}


async def run(
    requests: Sequence[tuple[str, str, dict[str, Any] | None, str]], concurrency: int
) -> tuple[list[tuple[str, int, float, dict[str, Any] | None]], float]:
    """(вид, шлях, тіло або None для GET, IP) → (вид, статус, секунди, відповідь), загальний час."""
    semaphore = asyncio.Semaphore(concurrency)
    results: list[tuple[str, int, float, dict[str, Any] | None]] = []
    async with httpx.AsyncClient(base_url=API, timeout=60) as client:

        async def one(kind: str, path: str, body: dict[str, Any] | None, ip: str) -> None:
            async with semaphore:
                started = time.perf_counter()
                try:
                    if body is None:
                        response = await client.get(path, headers=headers(ip))
                    else:
                        response = await client.post(path, json=body, headers=headers(ip))
                    data = response.json() if response.status_code == 200 else None
                    results.append(
                        (kind, response.status_code, time.perf_counter() - started, data)
                    )
                except httpx.HTTPError:
                    results.append((kind, 0, time.perf_counter() - started, None))

        started = time.perf_counter()
        await asyncio.gather(*(one(*r) for r in requests))
    return results, time.perf_counter() - started


def pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def latency_table(results: list[tuple[str, int, float, Any]]) -> list[str]:
    rows = ["| Вид | Запитів | Помилок | p50, с | p95, с | max, с |", "|---|---|---|---|---|---|"]
    for kind in sorted({r[0] for r in results}):
        own = [r for r in results if r[0] == kind]
        times = [r[2] for r in own]
        errors = sum(1 for r in own if r[1] != 200)
        rows.append(
            f"| {kind} | {len(own)} | {errors} ({errors / len(own):.0%}) | "
            f"{statistics.median(times):.2f} | {pct(times, 0.95):.2f} | {max(times):.2f} |"
        )
    return rows


async def main() -> None:
    random.seed(7)
    report: list[str] = ["# Навантажувальний тест SkyPack (V3, етап 8)", ""]
    server = uvicorn.Server(
        uvicorn.Config(fake_app, host="127.0.0.1", port=FAKE_PORT, log_level="warning")
    )
    fake_task = asyncio.create_task(server.serve())
    await asyncio.sleep(0.5)
    try:
        # 1. Змішане навантаження: 40 відвідувачів, 400 запитів, 9 різних пошуків.
        await flush()
        async with ApiProcess():
            requests = [
                (*random.choice(MIX), f"10.0.0.{random.randint(1, 40)}")  # noqa: S311
                for _ in range(400)
            ]
            results, total = await run(requests, concurrency=40)
            report += [
                "## 1. Змішане навантаження (400 запитів, 40 одночасно, 9 різних пошуків)",
                "",
                *latency_table(results),
                "",
                f"Пропускна здатність: {len(results) / total:.1f} запит/с за {total:.1f} с.",
                f"Зовнішні виклики: {dict(sorted(calls.items()))} — на 400 запитів.",
                "",
            ]
            stats = await Redis.from_url(REDIS_URL).hgetall(
                f"api:stats:{time.strftime('%Y-%m-%d', time.gmtime())}"
            )
            cache = {
                k.decode(): int(v) for k, v in stats.items() if k.decode().startswith("cache:")
            }
            report += [f"Кеш: {cache}", ""]

        # 2. Однакові одночасні: 60 × той самий новий пошук.
        await flush()
        async with ApiProcess():
            body = flight(4, back=True)
            results, total = await run(
                [("flights", "/flights/search", body, f"10.1.0.{i}") for i in range(60)], 60
            )
            report += [
                "## 2. Однакові одночасні запити (60 × той самий пошук туди й назад)",
                "",
                *latency_table(results),
                "",
                f"Зовнішні виклики: {dict(sorted(calls.items()))} "
                "(очікувано: SerpApi 1+, scrape.do 2 — туди й назад, Travelpayouts 1).",
                "",
            ]

        # 3. Бюджет: SerpApi 3 запити на добу, scrape.do 40 кредитів (4 запити).
        await flush()
        async with ApiProcess(SERPAPI_BUDGET_DAILY="3", SCRAPEDO_BUDGET_DAILY="40"):
            bodies = [flight(a, direct=d) for a in range(1, 10) for d in (False, True)]
            results, _ = await run(
                [("flights", "/flights/search", b, f"10.2.0.{i}") for i, b in enumerate(bodies)],
                6,
            )
            statuses: Counter[str] = Counter()
            for _, _, _, data in results:
                for provider in (data or {}).get("providers", []):
                    statuses[f"{provider['provider']}:{provider['status']}"] += 1
            report += [
                "## 3. Вичерпаний бюджет (SerpApi 3/добу, scrape.do 40 кредитів/добу; "
                "18 різних пошуків)",
                "",
                f"Відповідей 200: {sum(1 for r in results if r[1] == 200)} з {len(results)}.",
                f"Зовнішні виклики: {dict(sorted(calls.items()))}.",
                f"Статуси джерел у відповідях: {dict(sorted(statuses.items()))}.",
                "",
            ]

        # 4. Ліміт запитів: один IP — 50 пошуків при ліміті 40/год; інший IP — 5.
        await flush()
        async with ApiProcess(RATE_LIMIT_SEARCH_PER_HOUR="40"):
            one_ip = [("flights", "/flights/search", flight(1), "10.3.0.1")] * 50
            other = [("flights", "/flights/search", flight(1), "10.3.0.2")] * 5
            results, _ = await run(one_ip, 5)
            others, _ = await run(other, 5)
            report += [
                "## 4. Ліміт запитів (40/год на IP)",
                "",
                f"Один IP, 50 пошуків: {dict(Counter(r[1] for r in results))}.",
                f"Інший IP, 5 пошуків: {dict(Counter(r[1] for r in others))}.",
                "",
            ]

        # 5. Одночасні пошуки одного клієнта: 10 різних разом при ліміті 3.
        await flush()
        async with ApiProcess(MAX_CONCURRENT_SEARCHES="3"):
            bodies = [flight(a, direct=d) for a in range(1, 6) for d in (False, True)]
            results, _ = await run(
                [("search", "/flights/search", b, "10.4.0.1") for b in bodies], 10
            )
            report += [
                "## 5. Одночасні пошуки одного клієнта (10 разом, ліміт 3)",
                "",
                f"Статуси: {dict(Counter(r[1] for r in results))} (429 — понад ліміт).",
                "",
            ]

        # 6. Читання з бази: історія цін, 300 запитів, 30 одночасно.
        await flush()
        async with ApiProcess():
            path = "/flights/history?origin=WAW&destination=LIS&departure=2026-12-13"
            results, total = await run(
                [("history (БД)", path, None, f"10.5.0.{i % 50}") for i in range(300)], 30
            )
            report += [
                "## 6. Читання з бази (історія цін, 300 запитів, 30 одночасно)",
                "",
                *latency_table(results),
                "",
                f"Пропускна здатність: {len(results) / total:.1f} запит/с.",
                "",
            ]
    finally:
        server.should_exit = True
        await fake_task
        await flush()
    print("\n".join(report))


if __name__ == "__main__":
    asyncio.run(main())
