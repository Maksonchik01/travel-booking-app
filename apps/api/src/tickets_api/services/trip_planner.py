"""Комбінований підбір «переліт + житло» (етап 6, ADR 0009; модуль 8a, ADR 0021).

1. Перельоти туди-назад — звичайний пошук (точні чи гнучкі дати, тривалість, прямі, клас,
   багаж) і скоринг; кандидати — «Наш вибір» і найвигідніші за оцінкою (до MAX_FLIGHTS).
   Тариф, у якому потрібного багажу немає, — не кандидат (обов'язкова умова).
2. Житло з дня ПРИЛЬОТУ до дня вильоту НАЗАД (місцеві дати аеропортів): нічний переліт, що
   прилітає наступного дня, зсуває заїзд — житло на день вильоту туди не бронюємо. Вікон дат —
   не більше MAX_STAY_WINDOWS (кожне — запит до джерела житла), першими — вікна кращих рейсів.
   Побажання до житла — фільтри його пошуку.
3. Комбінації «рейс × рекомендоване житло його вікна». Вартість — розбивка за складовими
   з позначкою: підтверджена (ціна джерела на ці дати й склад), орієнтовна (кешована ціна,
   власні витрати) чи невідома (умови багажу тощо). `money_total` — сума ВІДОМИХ складових.
4. Сценарії: Економ — найменша сума (серед повністю відомих, якщо такі є); Оптимальний —
   найменша оцінка (ціна + «ціна» часу, пересадок, розташування, рейтингу й незручного часу);
   Комфорт — найменше пересадок і часу в дорозі, далі рейтинг і близькість житла. Вибір — у
   межах бюджету; немає таких — серед усіх з позначкою перевищення. Однаковий варіант не
   дублюється (`also`), тож сценаріїв може бути один чи два.
Усі числа рахує код; ШІ лише переказує їх.
"""

import asyncio
from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import FlightQuery, Money, Offer
from tickets_api.domain.saved_trips import TripRefreshRequest
from tickets_api.domain.stays import Stay, StayQuery
from tickets_api.domain.trips import FLIGHT_PROFILE, STAY_PROFILE, TRIP_NEARBY_KM, TripQuery
from tickets_api.scoring.baggage import BaggageCost
from tickets_api.scoring.engine import OfferScore, Pick, offer_key
from tickets_api.scoring.stays import StayScore, stay_key
from tickets_api.scoring.trip import (
    TimingWarning,
    TripScoringConfig,
    default_trip_scoring_config,
    timing,
)
from tickets_api.services.flight_search import AirlineFacet, FlightSearchService, ProviderStatus
from tickets_api.services.stay_search import StaySearchResult, StaySearchService

MAX_FLIGHTS = 6
MAX_STAY_WINDOWS = 3
MAX_STAY_OPTIONS = 8
MAX_CHEAPER_FLEX_DAYS = 3

TripPickLabel = Literal["cheapest", "best_value", "comfort"]
"""Економ, Оптимальний, Комфорт."""
TripWarning = Literal[TimingWarning, "value_unknown", "costs_unknown"]
PinnedStay = Literal["used", "partly", "unavailable"]
PinnedFlight = Literal["used", "unavailable"]
ChangeKind = Literal["dates", "origin_airport", "destination_airport", "flight", "stay"]
"""Обране житло: у всіх вікнах дат, лише в частині, ніде (на дати перельотів його немає)."""
CostKind = Literal["tickets", "baggage", "stay", "extra"]
CostStatus = Literal["confirmed", "approximate", "unknown"]
LABEL_PRECEDENCE: tuple[TripPickLabel, ...] = ("best_value", "cheapest", "comfort")
DISPLAY_ORDER: tuple[TripPickLabel, ...] = ("cheapest", "best_value", "comfort")


class StayWindow(BaseModel):
    check_in: date
    check_out: date
    nights: int


class CostItem(BaseModel):
    kind: CostKind
    label: str | None = None
    """Назва власної витрати (лише для `extra`)."""
    amount: Money | None
    """None — сума невідома."""
    status: CostStatus
    included: bool = False
    """Багаж: уже в ціні квитків (сума 0)."""


class TripCosts(BaseModel):
    """Розбивка бюджету: підтверджене й орієнтовне не змішуються, невідоме — окремо."""

    items: list[CostItem]
    confirmed: Money
    """Ціни джерел на ці дати й склад (живі ціни перельоту, житло з податками)."""
    approximate: Money
    """Кешовані ціни перельоту й витрати, додані вручну."""
    unknown: int
    """Скільки складових з невідомою сумою (не входять у `money_total`)."""


class TripCombo(BaseModel):
    key: str
    offer_key: str
    stay_key: str
    stay_index: int
    """Позиція житла в `TripSearchResult.stays`: той самий об'єкт на інші дати — інша ціна."""
    window: StayWindow
    arrival_at: datetime | None
    """Приліт туди (місцевий час аеропорту) — від нього дата заїзду."""
    return_departure_at: datetime
    """Виліт назад (місцевий час) — від нього дата виїзду."""
    flight_price: Money
    """Ціна квитків (уже за всіх пасажирів, ADR 0013)."""
    flight_total: Money
    """Квитки + відома доплата за багаж."""
    stay_total: Money
    """Житло за всі ночі з податками, за весь номер."""
    costs: TripCosts
    money_total: Money
    """Сума відомих складових (підтверджені + орієнтовні)."""
    value_total: Money | None
    """Оцінка «Оптимального»: None — не порахувати (невідома тривалість, інша валюта)."""
    stops: int
    """Пересадок туди й назад разом — для «Комфорту»."""
    currency: str
    warnings: list[TripWarning] = []


class TripPick(BaseModel):
    label: TripPickLabel
    combo_key: str
    also: list[TripPickLabel] = []
    over_budget: bool = False
    """У бюджет не вкладається жоден варіант — показуємо найкращий з позначкою."""


class TripBudget(BaseModel):
    budget: Money
    within: int
    """Скільки комбінацій вкладаються в бюджет (за відомими складовими)."""
    shortfall: Money | None
    """Якщо жодна не вкладається: на скільки дешевша з них перевищує бюджет."""


class FlightOption(BaseModel):
    """Рейс, на який можна замінити переліт (модуль 8b)."""

    offer_key: str
    window: StayWindow | None
    """Дати житла з цим рейсом (від прильоту); None — рейс без зворотного."""
    flight_total: Money
    """Квитки + відома доплата за багаж."""
    baggage_unknown: bool = False


class TripSearchResult(BaseModel):
    query: TripQuery
    flight_query: FlightQuery
    stay_queries: list[StayQuery]
    offers: list[Offer]
    """Рейси комбінацій і варіантів заміни."""
    stays: list[Stay]
    """Житло комбінацій і варіантів заміни (той самий об'єкт — окремо для кожного вікна дат)."""
    combos: list[TripCombo]
    """Від найвигіднішої до найменш вигідної (у межах бюджету — першими)."""
    picks: list[TripPick]
    budget: TripBudget | None = None
    providers: list[ProviderStatus]
    flights_found: int
    """Скільки рейсів знайшов пошук (кандидати — лише найкращі з них)."""
    airlines: list[AirlineFacet]
    """Назви авіакомпаній (з фасетів пошуку перельотів)."""
    pinned_stay: PinnedStay | None = None
    """Лише коли в запиті є `stay`."""
    pinned_flight: PinnedFlight | None = None
    """Лише коли в запиті є `flight`: пошук його знову дав чи ні."""
    selected: TripCombo | None = None
    """«Ваша поїздка» (8b): є, коли людина обрала рейс чи житло (`flight`/`stay`)."""
    flight_options: list[FlightOption] = []
    """Чим замінити переліт: кандидати пошуку, від кращого."""
    stay_options: list[int] = []
    """Чим замінити житло на дати «Вашої поїздки»: індекси в `stays`, від найвигіднішого."""


class CheaperResult(BaseModel):
    """«Знайти дешевший варіант» (8.4): було → стало, різниця й що змінилося."""

    status: Literal["found", "not_found", "no_trip"]
    before: TripCombo | None = None
    after: TripCombo | None = None
    saving: Money | None = None
    changes: list[ChangeKind] = []
    apply: TripQuery | None = None
    """Запит, що відкриє знайдений варіант як «Вашу поїздку» (точні дати, рейс, житло)."""
    offers: list[Offer] = []
    stays: list[Stay] = []
    """Житло `before`/`after` (їхні `stay_index` — у цьому списку)."""
    flights_checked: int = 0
    combos_checked: int = 0
    """Скільки перевірено — не весь ринок, глобально найнижчої ціни не обіцяємо."""


class TripRefresh(BaseModel):
    """Актуальний стан збереженої поїздки (8.7): чи є ще рейс і житло, нова сума й різниця."""

    current: TripCombo | None
    """«Ваша поїздка» зараз; None — нічого не знайшлося."""
    flight_available: bool
    """Обраний рейс знову знайшовся (False — показано найкращий інший)."""
    stay_available: bool
    """Обране житло є на дати рейсу (False — підібрано інше)."""
    difference: Money | None = None
    """Нова сума − збережена (+ дорожче, − дешевше)."""
    offer: Offer | None = None
    stay: Stay | None = None
    checked_at: datetime


class TripPlanner:
    def __init__(
        self,
        flights: FlightSearchService,
        stays: StaySearchService,
        config: TripScoringConfig | None = None,
    ) -> None:
        self._flights = flights
        self._stays = stays
        self._config = config or default_trip_scoring_config()

    async def plan(self, query: TripQuery) -> TripSearchResult:
        flight_query = flight_query_for(query)
        flights = await self._flights.search(flight_query)
        offers = {offer_key(o): o for o in flights.offers}
        flight_scores = {s.offer_key: s for s in flights.scoring.scores}
        candidates = _candidates(
            flights.offers,
            flights.scoring.picks,
            flight_scores,
            flights.baggage,
            first=query.flight,
        )
        pinned_offer = next((o for o in candidates if offer_key(o) == query.flight), None)

        windows: dict[tuple[date, date], list[Offer]] = {}
        for offer in candidates:
            window = stay_window(offer)
            if window is not None:
                windows.setdefault(window, []).append(offer)
        # Кандидати впорядковані (обраний рейс — першим), тож кращі вікна — першими.
        chosen = list(windows)[:MAX_STAY_WINDOWS]
        stay_queries = [
            StayQuery(
                city=query.destination,
                check_in=check_in,
                check_out=check_out,
                guests={"adults": query.adults, "children": query.children},
                currency=query.currency,
                profile=STAY_PROFILE[query.profile],
                filters=query.stay_filters,
            )
            for check_in, check_out in chosen
        ]
        stay_results: Sequence[StaySearchResult] = await asyncio.gather(
            *(self._stays.search(q) for q in stay_queries)
        )
        by_window = dict(zip(chosen, stay_results, strict=True))

        combos: list[TripCombo] = []
        used_stays: dict[tuple[str, date], int] = {}
        stay_list: list[Stay] = []

        def register(stay: Stay, check_in: date) -> int:
            key = (stay_key(stay), check_in)
            if key not in used_stays:
                used_stays[key] = len(stay_list)
                stay_list.append(stay)
            return used_stays[key]

        def combo_for(offer: Offer, stay: Stay, result: StaySearchResult) -> TripCombo:
            check_in, check_out = stay_window(offer) or (date.min, date.min)
            scores = {s.stay_key: s for s in result.scoring.scores}
            return self._combo(
                query,
                offer,
                flight_scores.get(offer_key(offer)),
                flights.baggage.get(offer_key(offer)),
                stay,
                register(stay, check_in),
                scores.get(stay_key(stay)),
                StayWindow(
                    check_in=check_in, check_out=check_out, nights=(check_out - check_in).days
                ),
            )

        pinned_windows = 0
        for window, result in by_window.items():
            stays = {stay_key(s): s for s in result.stays}
            stay_picks = [p.stay_key for p in result.scoring.picks if p.stay_key in stays]
            # Обране житло — замість рекомендованого, але лише якщо воно є на ці дати.
            if query.stay is not None and query.stay in stays:
                stay_picks = [query.stay]
                pinned_windows += 1
            for offer in windows[window]:
                for key in stay_picks:
                    if stays[key].currency != offer.currency:
                        continue  # курсів немає — суму в різних валютах не рахуємо
                    combos.append(combo_for(offer, stays[key], result))

        ordered = sorted(combos, key=lambda c: _rank(c, query.budget_total))
        pinned_stay = _pinned(query, pinned_windows, len(chosen))

        # «Ваша поїздка»: обраний рейс з обраним житлом, якщо воно є на дати цього рейсу;
        # інакше — найвигідніше житло цих дат. Без обраного рейсу — найкраща комбінація.
        selected: TripCombo | None = None
        pinned_flight: PinnedFlight | None = None
        if query.flight is not None:
            window = stay_window(pinned_offer) if pinned_offer else None
            pinned_flight = "used" if window in by_window else "unavailable"
            if pinned_offer is not None and window in by_window:
                result = by_window[window]
                stays = {stay_key(s): s for s in result.stays}
                pick = query.stay if query.stay in stays else _best_stay(result)
                if pick is not None and stays[pick].currency == pinned_offer.currency:
                    selected = combo_for(pinned_offer, stays[pick], result)
                    if query.stay is not None:
                        pinned_stay = "used" if pick == query.stay else "unavailable"
        if selected is None and (query.flight or query.stay) and ordered:
            selected = ordered[0]

        stay_options: list[int] = []
        if selected is not None:
            result = by_window[(selected.window.check_in, selected.window.check_out)]
            stay_options = [register(s, selected.window.check_in) for s in _by_value(result)]
        flight_options = [
            _flight_option(query, o, flights.baggage.get(offer_key(o))) for o in candidates
        ]
        shown = {c.offer_key for c in ordered} | {f.offer_key for f in flight_options}
        return TripSearchResult(
            query=query,
            flight_query=flight_query,
            stay_queries=stay_queries,
            offers=[o for k, o in offers.items() if k in shown],
            stays=stay_list,
            combos=ordered,
            picks=_picks(ordered, offers, stay_list, query.budget_total),
            budget=_budget(query, combos),
            providers=[
                *flights.providers,
                *(p for r in stay_results for p in r.providers),
            ],
            flights_found=len(flights.offers),
            airlines=flights.facets.airlines,
            pinned_stay=pinned_stay,
            pinned_flight=pinned_flight,
            selected=selected,
            flight_options=flight_options,
            stay_options=stay_options,
        )

    async def refresh(self, request: TripRefreshRequest) -> TripRefresh:
        """«Оновити ціни» збереженої поїздки: та сама конфігурація заново (з кешу джерел, де є)."""
        query = request.query
        result = await self.plan(query)
        current = result.selected or next(
            (c for c in result.combos if c.key in {p.combo_key for p in result.picks}), None
        )
        now = datetime.now(UTC)
        if current is None:
            return TripRefresh(
                current=None, flight_available=False, stay_available=False, checked_at=now
            )
        return TripRefresh(
            current=current.model_copy(update={"stay_index": 0}),
            flight_available=query.flight is None or current.offer_key == query.flight,
            stay_available=query.stay is None or current.stay_key == query.stay,
            difference=current.money_total - request.saved_total,
            offer=_offer(result, current.offer_key),
            stay=result.stays[current.stay_index],
            checked_at=now,
        )

    async def cheaper(self, query: TripQuery) -> CheaperResult:
        """Дешевший варіант тієї самої поїздки (8.4) за незмінних обов'язкових умов: склад,
        клас, прямі, багаж, побажання й тип житла, тривалість. Перевіряємо інші дати (±3 дні),
        сусідні аеропорти, інші рейси, інше житло та їхні комбінації. Варіант з більшою
        кількістю невідомих складових «дешевшим» не вважаємо."""
        current = await self.plan(query)
        before = current.selected or next(
            (c for c in current.combos if c.key in {p.combo_key for p in current.picks}), None
        )
        if before is None:
            return CheaperResult(status="no_trip")
        nights = before.window.nights
        wider = query.model_copy(
            update={
                "return_date": None,
                "flex_days": 0 if query.departure_until else MAX_CHEAPER_FLEX_DAYS,
                "min_nights": nights,
                "max_nights": nights,
                "nearby": True,
                "flight": None,
                "stay": None,
            }
        )
        broad = await self.plan(wider)
        pool = [(c, current) for c in current.combos] + [(c, broad) for c in broad.combos]
        kind = current.stays[before.stay_index].kind
        # Тип житла теж не міняємо: «дешевше» — не готель на хостел.
        cheaper = [
            (c, r)
            for c, r in pool
            if c.money_total < before.money_total
            and c.costs.unknown <= before.costs.unknown
            and c.window.nights == nights
            and r.stays[c.stay_index].kind == kind
        ]
        before_offer = _offer(current, before.offer_key)
        before_stay = current.stays[before.stay_index]
        flights_checked = current.flights_found + broad.flights_found
        combos_checked = len(current.combos) + len(broad.combos)
        if not cheaper:
            return CheaperResult(
                status="not_found",
                before=before.model_copy(update={"stay_index": 0}),
                offers=[before_offer],
                stays=[before_stay],
                flights_checked=flights_checked,
                combos_checked=combos_checked,
            )
        after, source = min(cheaper, key=lambda pair: (pair[0].money_total, _rank(pair[0], None)))
        after_offer = _offer(source, after.offer_key)
        after_stay = source.stays[after.stay_index]
        changes: list[ChangeKind] = []
        if after.window != before.window:
            changes.append("dates")
        if after_offer.outbound.origin != before_offer.outbound.origin:
            changes.append("origin_airport")
        if after_offer.outbound.destination != before_offer.outbound.destination:
            changes.append("destination_airport")
        if after.offer_key != before.offer_key:
            changes.append("flight")
        if after.stay_key != before.stay_key:
            changes.append("stay")
        airports = "origin_airport" in changes or "destination_airport" in changes
        inbound = after_offer.inbound
        apply = query.model_copy(
            update={
                "departure_date": after_offer.outbound.departure_at.date(),
                "return_date": inbound.departure_at.date() if inbound else None,
                "flex_days": 0,
                "departure_until": None,
                "min_nights": None,
                "max_nights": None,
                "nearby": query.nearby or airports,
                "flight": after.offer_key,
                "stay": after.stay_key,
            }
        )
        return CheaperResult(
            status="found",
            before=before.model_copy(update={"stay_index": 0}),
            after=after.model_copy(update={"stay_index": 1}),
            saving=before.money_total - after.money_total,
            changes=changes,
            apply=apply,
            offers=[before_offer, after_offer],
            stays=[before_stay, after_stay],
            flights_checked=flights_checked,
            combos_checked=combos_checked,
        )

    def _combo(
        self,
        query: TripQuery,
        offer: Offer,
        flight_score: OfferScore | None,
        baggage: BaggageCost | None,
        stay: Stay,
        stay_index: int,
        stay_score: StayScore | None,
        window: StayWindow,
    ) -> TripCombo:
        costs = trip_costs(query, offer, baggage, stay)
        bag_extra = sum(
            (i.amount or Decimal(0) for i in costs.items if i.kind == "baggage"), Decimal(0)
        )
        penalty, timing_warnings = timing(offer, self._config)
        warnings: list[TripWarning] = list(timing_warnings)
        seated = query.adults + query.children
        flight_value = flight_score.breakdown.total if flight_score else None
        stay_value = stay_score.breakdown.total if stay_score else None
        value = None
        if (
            flight_value is not None
            and stay_value is not None
            and offer.currency == self._config.currency
        ):
            # Ціна й оцінка перельоту вже за всіх пасажирів (ADR 0013); незручний час — на кожного.
            value = flight_value + bag_extra + stay_value * window.nights + penalty * seated
        else:
            warnings.append("value_unknown")
        if costs.unknown:
            warnings.append("costs_unknown")
        back = offer.inbound
        if back is None:  # вікно житла є лише в рейсів туди-назад
            raise ValueError("поїздка — лише з рейсом назад")
        return TripCombo(
            key=f"{offer_key(offer)}|{stay_key(stay)}",
            offer_key=offer_key(offer),
            stay_key=stay_key(stay),
            stay_index=stay_index,
            window=window,
            arrival_at=offer.outbound.arrival_at,
            return_departure_at=back.departure_at,
            flight_price=offer.price,
            flight_total=offer.price + bag_extra,
            stay_total=stay.total_price,
            costs=costs,
            money_total=costs.confirmed + costs.approximate,
            value_total=value,
            stops=offer.outbound.stops + back.stops,
            currency=offer.currency,
            warnings=warnings,
        )


def flight_query_for(query: TripQuery) -> FlightQuery:
    """Запит перельотів з умов поїздки. Тривалість без періоду — період з одного дня
    (FlightQuery рахує ночі лише в гнучкому пошуку)."""
    until = query.departure_until
    if query.nights_range is not None and until is None and not query.flex_days:
        until = query.departure_date
    radius = TRIP_NEARBY_KM if query.nearby else 0
    return FlightQuery(
        origin=query.origin,
        destination=query.destination,
        departure_date=query.departure_date,
        return_date=query.flight_return_date,
        flex_days=query.flex_days,
        departure_until=until,
        min_nights=query.min_nights,
        max_nights=query.max_nights,
        passengers={"adults": query.adults, "children": query.children},
        cabin=query.cabin,
        baggage=query.baggage,
        direct_only=query.direct_only,
        currency=query.currency,
        profile=FLIGHT_PROFILE[query.profile],
        origin_radius_km=radius,
        destination_radius_km=radius,
    )


def stay_window(offer: Offer) -> tuple[date, date] | None:
    """Ночі житла: від дати прильоту туди до дати вильоту назад (місцеві дати).

    Нічний рейс (виліт 23:40, приліт 02:10 наступного дня) — заїзд у день прильоту, не вильоту.
    """
    if offer.inbound is None:
        return None
    out = offer.outbound
    check_in = (out.arrival_at or out.departure_at).date()
    check_out = offer.inbound.departure_at.date()
    return (check_in, check_out) if check_out > check_in else None


def trip_costs(
    query: TripQuery, offer: Offer, baggage: BaggageCost | None, stay: Stay
) -> TripCosts:
    """Складові вартості з позначкою достовірності. Нічого не домальовуємо: трансфер без
    даних не додаємо, невідому доплату за багаж не вважаємо нульовою."""
    ticket_status: CostStatus = "confirmed" if offer.price_status == "live" else "approximate"
    items = [CostItem(kind="tickets", amount=offer.price, status=ticket_status)]
    if query.baggage != "none":
        if baggage is None or baggage.extra is None:
            items.append(CostItem(kind="baggage", amount=None, status="unknown"))
        else:
            items.append(
                CostItem(
                    kind="baggage",
                    amount=baggage.extra,
                    status=ticket_status,
                    included=baggage.status == "included",
                )
            )
    items.append(CostItem(kind="stay", amount=stay.total_price, status="confirmed"))
    items.extend(
        CostItem(kind="extra", label=e.label, amount=e.amount, status="approximate")
        for e in query.extras
    )

    def total(status: CostStatus) -> Decimal:
        return sum((i.amount or Decimal(0) for i in items if i.status == status), Decimal(0))

    return TripCosts(
        items=items,
        confirmed=total("confirmed"),
        approximate=total("approximate"),
        unknown=sum(1 for i in items if i.status == "unknown"),
    )


def _candidates(
    offers: list[Offer],
    picks: Sequence[Pick],
    scores: dict[str, OfferScore],
    baggage: dict[str, BaggageCost],
    *,
    first: str | None = None,
) -> list[Offer]:
    """«Наш вибір» пошуку, далі — найвигідніші за оцінкою; без тарифів, де потрібного багажу
    немає. Порядок — від кращого: він же визначає, які вікна дат перевіряємо. `first` — рейс,
    який обрала людина (8b): він першим, якщо пошук його дав."""
    by_key = {offer_key(o): o for o in offers}
    ordered = [*([first] if first else []), *(p.offer_key for p in picks)]
    ordered += sorted(
        scores,
        key=lambda k: t if (t := scores[k].breakdown.total) is not None else Decimal("Infinity"),
    )
    result: dict[str, Offer] = {}
    for key in ordered:
        offer = by_key.get(key)
        if offer is None or key in result:
            continue
        if key in baggage and baggage[key].status == "not_available":
            continue
        result[key] = offer
        if len(result) == MAX_FLIGHTS:
            break
    return list(result.values())


def _offer(result: TripSearchResult, key: str) -> Offer:
    return next(o for o in result.offers if offer_key(o) == key)


def _best_stay(result: StaySearchResult) -> str | None:
    """Найвигідніше житло вікна: вибір скорингу «balanced», інакше перше з вибору."""
    picks = {p.label: p.stay_key for p in result.scoring.picks}
    return picks.get("balanced") or next(iter(picks.values()), None)


def _by_value(result: StaySearchResult) -> list[Stay]:
    """Житло вікна від найвигіднішого (без оцінки — у кінці), не більше MAX_STAY_OPTIONS."""
    scores = {s.stay_key: s.breakdown.total for s in result.scoring.scores}

    def value(stay: Stay) -> tuple[bool, Decimal]:
        total = scores.get(stay_key(stay))
        return (total is None, total if total is not None else stay.total_price)

    return sorted(result.stays, key=value)[:MAX_STAY_OPTIONS]


def _flight_option(query: TripQuery, offer: Offer, baggage: BaggageCost | None) -> FlightOption:
    window = stay_window(offer)
    unknown = query.baggage != "none" and (baggage is None or baggage.extra is None)
    extra = baggage.extra if baggage is not None and baggage.extra is not None else Decimal(0)
    return FlightOption(
        offer_key=offer_key(offer),
        window=None
        if window is None
        else StayWindow(
            check_in=window[0], check_out=window[1], nights=(window[1] - window[0]).days
        ),
        flight_total=offer.price + (extra if query.baggage != "none" else Decimal(0)),
        baggage_unknown=unknown,
    )


def _pinned(query: TripQuery, found: int, windows: int) -> PinnedStay | None:
    if query.stay is None:
        return None
    if found == 0:
        return "unavailable"
    return "used" if found == windows else "partly"


def _within(combo: TripCombo, budget: int | None) -> bool:
    return budget is None or combo.money_total <= budget


def _rank(combo: TripCombo, budget: int | None) -> tuple[bool, Decimal, Decimal]:
    """У межах бюджету — першими, далі за вигідністю, потім за ціною."""
    value = combo.value_total if combo.value_total is not None else Decimal("Infinity")
    return (not _within(combo, budget), value, combo.money_total)


def _budget(query: TripQuery, combos: list[TripCombo]) -> TripBudget | None:
    if query.budget_total is None:
        return None
    within = [c for c in combos if _within(c, query.budget_total)]
    cheapest = min((c.money_total for c in combos), default=None)
    return TripBudget(
        budget=Decimal(query.budget_total),
        within=len(within),
        shortfall=None if within or cheapest is None else cheapest - Decimal(query.budget_total),
    )


def _picks(
    combos: list[TripCombo],
    offers: dict[str, Offer],
    stays: list[Stay],
    budget: int | None,
) -> list[TripPick]:
    # Вибір — серед тих, що в бюджеті; якщо таких немає — серед усіх, з позначкою.
    within = [c for c in combos if _within(c, budget)]
    pool = within or combos
    if not pool:
        return []
    # Економ — серед повністю відомих сум, якщо такі є (невідомий багаж не робить дешевшим).
    known = [c for c in pool if c.costs.unknown == 0] or pool

    def comfort(c: TripCombo) -> tuple[int, int, Decimal, Decimal, Decimal]:
        minutes = offers[c.offer_key].total_duration_min
        stay = stays[c.stay_index]
        return (
            c.stops,
            minutes if minutes is not None else 10**6,
            -(stay.rating if stay.rating is not None else Decimal(-1)),
            stay.distance_to_center_km if stay.distance_to_center_km is not None else Decimal(999),
            c.money_total,
        )

    winners: dict[TripPickLabel, str] = {
        "cheapest": min(known, key=lambda c: (c.money_total, _rank(c, budget))).key,
        "best_value": min(pool, key=lambda c: _rank(c, budget)).key,
        "comfort": min(pool, key=comfort).key,
    }
    picks: dict[str, TripPick] = {}
    for label in LABEL_PRECEDENCE:
        key = winners[label]
        if key in picks:
            picks[key].also.append(label)
        else:
            picks[key] = TripPick(label=label, combo_key=key, over_budget=not within)
    order = {label: i for i, label in enumerate(DISPLAY_ORDER)}
    return sorted(picks.values(), key=lambda p: order[p.label])
