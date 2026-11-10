"""Джерела ціни для підписок на житло й повну поїздку (модуль 11a).

Вмикаються лише з реальним джерелом житла: на mock-даних сповіщення не мають сенсу, тож
`build_alert_service` їх не підключає, і створити такі підписки не можна (ТЗ 11.4).
"""

from decimal import Decimal

from tickets_api.db.models import Alert
from tickets_api.domain.stays import Guests, StayFilters, StayQuery
from tickets_api.services.alerts import Found, PriceSource
from tickets_api.services.stay_search import StaySearchService


def stay_price_source(stays: StaySearchService) -> PriceSource:
    """Конкретний об'єкт (`stay_key`) або найдешевша пропозиція в місті на ці дати —
    ціна з податками за весь номер і весь час проживання."""

    async def price(alert: Alert) -> Found | None:
        if alert.return_date is None:
            return None
        query = StayQuery(
            city=alert.destination,
            check_in=alert.departure_date,
            check_out=alert.return_date,
            guests=Guests(adults=alert.adults),
            currency=alert.currency,
            filters=StayFilters(min_rating=alert.min_rating),
        )
        result = await stays.search(query)
        prices = [
            s.total_price
            for s in result.stays
            if s.currency == alert.currency
            and (alert.stay_key is None or f"{s.source}:{s.id}" == alert.stay_key)
        ]
        return Found(price=min(prices)) if prices else None

    return price


def trip_price_source(flights: PriceSource, stays: PriceSource) -> PriceSource:
    """Поїздка = найдешевший переліт туди-назад + найдешевше житло на ті самі дати.

    Житло — з дати вильоту до дати повернення (нічний рейс тут не враховано: це оцінка для
    сповіщення, точну суму рахує планувальник поїздки за посиланням)."""

    async def price(alert: Alert) -> Found | None:
        flight = await flights(alert)
        stay = await stays(alert)
        if flight is None or stay is None:
            return None
        total: Decimal = flight.price + stay.price
        return Found(
            price=total,
            departure=flight.departure,
            return_date=flight.return_date,
            baggage_unknown=flight.baggage_unknown,
        )

    return price
