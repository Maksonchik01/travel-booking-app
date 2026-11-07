"""Курси ЄЦБ на ЗАПИСАНІЙ відповіді (tests/fixtures/ecb/) і скоринг у валюті пошуку."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
import respx
from flight_fakes import FakeRedis, StubProvider, offers_for
from tickets_api.domain.flights import FlightQuery
from tickets_api.providers.fx import ECB_DAILY_URL, EcbRates, parse_ecb
from tickets_api.scoring.config import default_scoring_config
from tickets_api.services.flight_search import FlightSearchService

XML = (Path(__file__).parent / "fixtures" / "ecb" / "eurofxref-daily.xml").read_text()


def test_parse_recorded_ecb_rates() -> None:
    rates = parse_ecb(XML)
    assert rates["EUR"] == Decimal(1)
    assert rates["USD"] == Decimal("1.1165")
    assert rates["PLN"] == Decimal("4.3925")
    assert "UAH" not in rates  # гривні в довідкових курсах ЄЦБ немає


@respx.mock
async def test_rates_are_cached_and_cross_rates_computed() -> None:
    route = respx.get(ECB_DAILY_URL).mock(return_value=httpx.Response(200, text=XML))
    async with httpx.AsyncClient() as http:
        fx = EcbRates(http, FakeRedis())  # type: ignore[arg-type]
        assert await fx.rate("EUR", "USD") == Decimal("1.1165")
        assert await fx.rate("USD", "EUR") == Decimal(1) / Decimal("1.1165")
        assert await fx.rate("EUR", "UAH") is None
        assert await fx.rate("EUR", "EUR") == Decimal(1)
    assert route.call_count == 1  # далі — з кешу


@respx.mock
async def test_ecb_down_uses_last_known_rate() -> None:
    redis = FakeRedis()
    async with httpx.AsyncClient() as http:
        respx.get(ECB_DAILY_URL).mock(return_value=httpx.Response(200, text=XML))
        await EcbRates(http, redis).rate("EUR", "USD")  # type: ignore[arg-type]
        await redis.delete("fx:ecb:eur")  # свіжий кеш минув
        respx.get(ECB_DAILY_URL).mock(return_value=httpx.Response(503))
        assert await EcbRates(http, redis).rate("EUR", "PLN") == Decimal("4.3925")  # type: ignore[arg-type]
        assert await EcbRates(http, FakeRedis()).rate("EUR", "PLN") is None  # type: ignore[arg-type]


def test_scoring_weights_scale_with_rate() -> None:
    base = default_scoring_config()
    usd = base.in_currency("USD", Decimal(2))
    assert usd.currency == "USD"
    assert (
        usd.profiles["balanced"].lambda_time_per_hour
        == base.profiles["balanced"].lambda_time_per_hour * 2
    )
    assert usd.penalties.self_transfer == base.penalties.self_transfer * 2
    assert usd.thresholds == base.thresholds  # хвилини й години не конвертуємо
    assert base.in_currency("EUR", Decimal(2)) is base


@pytest.mark.parametrize(("rate", "scored"), [(Decimal("1.1"), True), (None, False)])
async def test_search_in_usd_is_scored_only_with_a_rate(rate: Decimal | None, scored: bool) -> None:
    async def fx(base: str, currency: str) -> Decimal | None:
        return rate

    usd = [o.model_copy(update={"currency": "USD"}) for o in offers_for("a", [100, 120])]
    svc = FlightSearchService(
        [StubProvider("a", offers=usd)],
        timeout_s=0.2,
        scoring_config=default_scoring_config(),
        fx=fx,
    )
    query = FlightQuery(
        origin="WAW", destination="LIS", departure_date=date(2026, 11, 10), currency="USD"
    )

    result = await svc.search(query)

    assert bool(result.scoring.picks) is scored
    assert result.scoring.currency == ("USD" if scored else "EUR")
    assert bool(result.scoring.unscored_offer_keys) is not scored
