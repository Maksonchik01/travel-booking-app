"""Mock-провайдер: детерміновані реалістичні дані для розробки й тестів без токенів.

Той самий запит завжди дає ті самі пропозиції (seed з маршруту й дат), а серед них
трапляються всі випадки, які потрібні скорингу: прямі рейси, короткі (<60 хв), нічні
й самостійні пересадки, лоукости без багажу.
"""

import calendar as _calendar
import hashlib
import random
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from tickets_api.domain.flights import (
    CalendarDay,
    FlightQuery,
    Layover,
    Leg,
    Offer,
    Segment,
)

Clock = Callable[[], datetime]

HUBS = ("FRA", "MUC", "VIE", "IST", "AMS", "CDG", "WAW", "ZRH", "CPH", "LIS")
FULL_SERVICE = ("LH", "OS", "TK", "KL", "AF", "LO", "LX", "SK", "TP")
LOW_COST = ("FR", "W6", "U2")
# Приблизні курси лише для того, щоб mock відповідав у запитаній валюті.
RATES_FROM_EUR = {
    "EUR": Decimal(1),
    "USD": Decimal("1.08"),
    "GBP": Decimal("0.85"),
    "PLN": Decimal("4.30"),
    "UAH": Decimal("45.00"),
}
DEPARTURE_SLOTS = (
    time(6, 10),
    time(7, 45),
    time(9, 30),
    time(12, 15),
    time(15, 40),
    time(18, 5),
    time(21, 20),
    time(23, 35),
)
# Тривалості пересадок у хвилинах: від ризиково коротких до нічних.
LAYOVER_CHOICES = (40, 55, 75, 110, 180, 300, 540)
NIGHT_START, NIGHT_END = time(0, 0), time(6, 0)


def _rng(*parts: object) -> random.Random:
    # hashlib, а не hash(): hash() рандомізується між процесами.
    digest = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))  # noqa: S311 — не криптографія


def _overlaps_night(start: datetime, end: datetime) -> bool:
    day = start.date()
    while day <= end.date():
        night_from = datetime.combine(day, NIGHT_START, UTC)
        night_to = datetime.combine(day, NIGHT_END, UTC)
        if start < night_to and end > night_from:
            return True
        day += timedelta(days=1)
    return False


class MockFlightProvider:
    name = "mock"

    def __init__(self, clock: Clock | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))

    async def search(self, query: FlightQuery) -> list[Offer]:
        collected_at = self._clock().replace(microsecond=0)
        offers: list[Offer] = []
        for shift in range(-query.flex_days, query.flex_days + 1):
            dep = query.departure_date + timedelta(days=shift)
            ret = query.return_date + timedelta(days=shift) if query.return_date else None
            offers.extend(self._offers_for_dates(query, dep, ret, collected_at))
        return sorted(offers, key=lambda o: (o.price, o.id))

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        days_in_month = _calendar.monthrange(month.year, month.month)[1]
        result: list[CalendarDay] = []
        for day in range(1, days_in_month + 1):
            query = FlightQuery(
                origin=origin,
                destination=destination,
                departure_date=month.replace(day=day),
                currency=currency,
            )
            offers = await self.search(query)
            if not offers:
                continue
            cheapest = offers[0]
            result.append(
                CalendarDay(
                    date=query.departure_date,
                    price=cheapest.price,
                    currency=cheapest.currency,
                    stops=cheapest.stops,
                    airline=cheapest.airlines[0],
                    source=self.name,
                    collected_at=cheapest.collected_at,
                    found_at=cheapest.found_at,
                )
            )
        return result

    def _offers_for_dates(
        self, query: FlightQuery, dep: date, ret: date | None, collected_at: datetime
    ) -> list[Offer]:
        route = _rng("route", query.origin, query.destination)
        has_direct = route.random() < 0.7
        direct_minutes = route.randint(80, 540)
        base_price_eur = Decimal(route.randint(45, 380))

        rng = _rng("day", query.origin, query.destination, dep, ret)
        stop_options = [0] if has_direct else []
        if not query.direct_only:
            stop_options += [1, 1, 2]
        offers = []
        for variant, stops in enumerate(stop_options):
            low_cost = stops > 0 and rng.random() < 0.35
            outbound = self._leg(
                rng, query.origin, query.destination, dep, stops, direct_minutes, low_cost
            )
            inbound = None
            if ret is not None:
                back_stops = 0 if query.direct_only else min(stops, 1 if has_direct else 2)
                inbound = self._leg(
                    rng,
                    query.destination,
                    query.origin,
                    ret,
                    back_stops,
                    direct_minutes,
                    low_cost,
                )
            offers.append(
                self._offer(
                    rng,
                    query,
                    variant,
                    outbound,
                    inbound,
                    base_price_eur,
                    low_cost,
                    collected_at,
                )
            )
        return offers

    def _leg(
        self,
        rng: random.Random,
        origin: str,
        destination: str,
        day: date,
        stops: int,
        direct_minutes: int,
        low_cost: bool,
    ) -> Leg:
        hubs = rng.sample([h for h in HUBS if h not in (origin, destination)], stops)
        airports = [origin, *hubs, destination]
        carriers = LOW_COST if low_cost else FULL_SERVICE
        # Рейс через хаб довший за прямий: кожне плече — частка прямого + набір висоти.
        leg_minutes = [
            max(50, int(direct_minutes * rng.uniform(0.55, 0.8))) if stops else direct_minutes
            for _ in range(stops + 1)
        ]
        cursor = datetime.combine(day, rng.choice(DEPARTURE_SLOTS), UTC)
        segments: list[Segment] = []
        layovers: list[Layover] = []
        for i, minutes in enumerate(leg_minutes):
            carrier = rng.choice(carriers)
            arrival = cursor + timedelta(minutes=minutes)
            segments.append(
                Segment(
                    origin=airports[i],
                    destination=airports[i + 1],
                    departure_at=cursor,
                    arrival_at=arrival,
                    carrier=carrier,
                    flight_number=f"{carrier}{rng.randint(100, 9999)}",
                    duration_min=minutes,
                )
            )
            if i < stops:
                wait = rng.choice(LAYOVER_CHOICES)
                next_departure = arrival + timedelta(minutes=wait)
                layovers.append(
                    Layover(
                        airport=airports[i + 1],
                        duration_min=wait,
                        overnight=_overlaps_night(arrival, next_departure),
                        # Лоукости не продають стиковок: кожен сегмент — окремий квиток.
                        self_transfer=low_cost,
                    )
                )
                cursor = next_departure
        first, last = segments[0], segments[-1]
        return Leg(
            origin=origin,
            destination=destination,
            departure_at=first.departure_at,
            arrival_at=last.arrival_at,
            duration_min=int((last.arrival_at - first.departure_at).total_seconds() // 60),
            stops=stops,
            segments=segments,
            layovers=layovers,
            flight_number=first.flight_number,
        )

    def _offer(
        self,
        rng: random.Random,
        query: FlightQuery,
        variant: int,
        outbound: Leg,
        inbound: Leg | None,
        base_price_eur: Decimal,
        low_cost: bool,
        collected_at: datetime,
    ) -> Offer:
        # Більше пересадок і лоукост — дешевше; невеликий шум, щоб варіанти не збігались.
        factor = Decimal(1) - Decimal("0.18") * outbound.stops
        factor *= Decimal("0.7") if low_cost else Decimal(1)
        factor *= Decimal(str(round(rng.uniform(0.85, 1.25), 2)))
        price_eur = base_price_eur * factor * (Decimal("1.9") if inbound else Decimal(1))
        rate = RATES_FROM_EUR.get(query.currency, Decimal(1))
        currency = query.currency if query.currency in RATES_FROM_EUR else "EUR"
        price = (price_eur * rate).quantize(Decimal(1), rounding=ROUND_HALF_UP)

        legs = [outbound, *([inbound] if inbound else [])]
        airlines = sorted({s.carrier for leg in legs for s in leg.segments or []})
        flight_numbers = "-".join(s.flight_number for leg in legs for s in leg.segments or [])
        offer_id = hashlib.sha1(  # noqa: S324 — не криптографія, лише стабільний id
            f"{self.name}|{variant}|{outbound.departure_at}|{flight_numbers}".encode()
        ).hexdigest()[:16]
        return Offer(
            id=offer_id,
            source=self.name,
            price=max(price, Decimal(15)),
            currency=currency,
            outbound=outbound,
            inbound=inbound,
            airlines=airlines,
            details_level="full",
            baggage_included=not low_cost,
            collected_at=collected_at,
            found_at=collected_at - timedelta(hours=rng.randint(1, 30)),
            deep_link=None,
        )
