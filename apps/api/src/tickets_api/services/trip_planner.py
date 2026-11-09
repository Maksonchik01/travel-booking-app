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
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from tickets_api.domain.flights import FlightQuery, Money, Offer
from tickets_api.domain.money import convert
from tickets_api.domain.saved_trips import (
    TripFlightSnapshot,
    TripRefreshRequest,
    TripSnapshot,
    TripStaySnapshot,
)
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
from tickets_api.services.flight_search import (
    AirlineFacet,
    FlightSearchService,
    ProviderStatus,
    offer_in_currency,
)
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


TripReasonCode = Literal[
    "only_option",
    "cheapest",
    "best_value",
    "comfort",
    "pricier_but_faster",
    "better_rated_stay",
    "closer_stay",
    "more_full_nights",
    "fewer_stops",
    "cheaper_than_comfort",
    "all_nights_full",
    "within_budget",
    "over_budget",
]
MIN_TRIP_TIME_GAIN_MIN = 30
MIN_STAY_RATING_GAIN = Decimal("0.3")
MIN_STAY_DISTANCE_GAIN_KM = Decimal("0.5")


class TripReason(BaseModel):
    """Причина «Чому цей варіант?» поїздки (модуль 14.5) — факт з даних, рахує код.

    Гроші — сума поїздки за відомими складовими; `vs` — з яким сценарієм порівнюємо."""

    code: TripReasonCode
    vs: TripPickLabel | None = None
    amount: Money | None = None
    minutes: int | None = None
    count: int | None = None
    rating: Money | None = None
    km: Money | None = None


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
    converted_from: list[str] = []
    """Валюти, з яких суми переведено у валюту поїздки за курсом ЄЦБ (модуль 18.2): тоді
    вони орієнтовні; продавець спише у своїй валюті."""
    full_nights: int = 0
    """Повноцінних ночей (модуль 14.4): без першої при пізньому прильоті (з 23:00) і останньої
    при ранньому вильоті назад (до 07:00) — їх оплачено, але виспатися не вийде."""
    travel_min: int | None = None
    """У дорозі туди й назад разом; None — тривалість невідома."""
    waiting_min: int | None = None
    """З них — очікування на пересадках; None — деталі пересадок невідомі."""
    reasons: list[TripReason] = []


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
        # Одна валюта поїздки (модуль 18.2): штрафи часу — у ній; рейс чи житло в іншій валюті
        # рахуємо за курсом ЄЦБ — орієнтовно, а у видачі лишаються вихідні ціни.
        rate = await self._flights.rate(self._config.currency, query.currency)
        config = self._config.in_currency(query.currency, rate) if rate else self._config

        def fx_offer(offer: Offer) -> Offer:
            conv = flights.converted.get(offer_key(offer))
            return offer_in_currency(offer, conv.currency, conv.rate) if conv else offer

        def fx_stay(stay: Stay, result: StaySearchResult) -> Stay:
            conv = result.converted.get(stay_key(stay))
            if conv is None:
                return stay
            return stay.model_copy(
                update={
                    "price_per_night": convert(stay.price_per_night, conv.rate),
                    "total_price": conv.amount,
                    "currency": conv.currency,
                }
            )

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
                preferences=query.preferences.stays if query.preferences else None,
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
                fx_offer(offer),
                flight_scores.get(offer_key(offer)),
                flights.baggage.get(offer_key(offer)),
                fx_stay(stay, result),
                register(stay, check_in),
                scores.get(stay_key(stay)),
                StayWindow(
                    check_in=check_in, check_out=check_out, nights=(check_out - check_in).days
                ),
                config,
                converted_from=[
                    c.original_currency
                    for c in (
                        flights.converted.get(offer_key(offer)),
                        result.converted.get(stay_key(stay)),
                    )
                    if c is not None
                ],
                converted=offer_key(offer) in flights.converted,
                stay_converted=stay_key(stay) in result.converted,
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
                    if fx_stay(stays[key], result).currency != fx_offer(offer).currency:
                        continue  # курсу немає — суму в різних валютах не рахуємо
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
                if (
                    pick is not None
                    and fx_stay(stays[pick], result).currency == fx_offer(pinned_offer).currency
                ):
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
        picks = _picks(ordered, offers, stay_list, query.budget_total)
        explain = _explainer(ordered, picks, stay_list, query.budget_total)
        return TripSearchResult(
            query=query,
            flight_query=flight_query,
            stay_queries=stay_queries,
            offers=[o for k, o in offers.items() if k in shown],
            stays=stay_list,
            combos=[explain(c) for c in ordered],
            picks=picks,
            budget=_budget(query, combos),
            providers=[
                *flights.providers,
                *(p for r in stay_results for p in r.providers),
            ],
            flights_found=len(flights.offers),
            airlines=flights.facets.airlines,
            pinned_stay=pinned_stay,
            pinned_flight=pinned_flight,
            selected=explain(selected) if selected is not None else None,
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
        config: TripScoringConfig | None = None,
        *,
        converted: bool = False,
        stay_converted: bool = False,
        converted_from: list[str] | None = None,
    ) -> TripCombo:
        """`offer` і `stay` — уже у валюті поїздки; `converted` — переведені за курсом (тоді
        їхні суми орієнтовні, модуль 18.2)."""
        config = config or self._config
        costs = trip_costs(
            query, offer, baggage, stay, converted=converted, stay_converted=stay_converted
        )
        bag_extra = sum(
            (i.amount or Decimal(0) for i in costs.items if i.kind == "baggage"), Decimal(0)
        )
        penalty, timing_warnings = timing(offer, config)
        warnings: list[TripWarning] = list(timing_warnings)
        seated = query.adults + query.children
        flight_value = flight_score.breakdown.total if flight_score else None
        stay_value = stay_score.breakdown.total if stay_score else None
        value = None
        if (
            flight_value is not None
            and stay_value is not None
            and offer.currency == config.currency
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
            converted_from=sorted(set(converted_from or [])),
            full_nights=max(
                0,
                window.nights
                - ("late_arrival" in timing_warnings)
                - ("early_return" in timing_warnings),
            ),
            travel_min=offer.total_duration_min,
            waiting_min=_waiting(offer),
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
        preferences=query.preferences.flights if query.preferences else None,
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
    query: TripQuery,
    offer: Offer,
    baggage: BaggageCost | None,
    stay: Stay,
    *,
    converted: bool = False,
    stay_converted: bool = False,
) -> TripCosts:
    """Складові вартості з позначкою достовірності. Нічого не домальовуємо: трансфер без
    даних не додаємо, невідому доплату за багаж не вважаємо нульовою. Переведене з іншої
    валюти за курсом — завжди орієнтовне: продавець спише у своїй валюті (модуль 18.2)."""
    live = offer.price_status == "live" and not converted
    ticket_status: CostStatus = "confirmed" if live else "approximate"
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
    items.append(
        CostItem(
            kind="stay",
            amount=stay.total_price,
            status="approximate" if stay_converted else "confirmed",
        )
    )
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


def _waiting(offer: Offer) -> int | None:
    total = 0
    for leg in (offer.outbound, offer.inbound):
        if leg is None or leg.stops == 0:
            continue
        if leg.layovers is None:
            return None
        total += sum(lay.duration_min for lay in leg.layovers)
    return total


def _explainer(
    combos: list[TripCombo], picks: list[TripPick], stays: list[Stay], budget: int | None
) -> Callable[[TripCombo], TripCombo]:
    """«Чому цей варіант?» поїздки: що виграла і чим відрізняється від «Економу» (дорожче, але
    менше в дорозі, краще житло, більше повноцінних ночей) та «Комфорту» (дешевше)."""
    winners = {label: p.combo_key for p in picks for label in (p.label, *p.also)}
    by_key = {c.key: c for c in combos}
    cheapest = by_key.get(winners.get("cheapest", ""))
    comfort = by_key.get(winners.get("comfort", ""))

    def explain(combo: TripCombo) -> TripCombo:
        reasons: list[TripReason] = []
        if len(combos) == 1:
            reasons.append(TripReason(code="only_option"))
        else:
            for label in ("cheapest", "best_value", "comfort"):
                if winners.get(label) == combo.key:
                    reasons.append(TripReason(code=label, count=len(combos)))
        if cheapest is not None and cheapest.key != combo.key:
            extra = max(combo.money_total - cheapest.money_total, Decimal(0))
            if combo.travel_min is not None and cheapest.travel_min is not None:
                gain = cheapest.travel_min - combo.travel_min
                if gain >= MIN_TRIP_TIME_GAIN_MIN:
                    reasons.append(
                        TripReason(
                            code="pricier_but_faster", vs="cheapest", amount=extra, minutes=gain
                        )
                    )
            if combo.stops < cheapest.stops:
                reasons.append(
                    TripReason(
                        code="fewer_stops", vs="cheapest", count=cheapest.stops - combo.stops
                    )
                )
            mine, base = stays[combo.stay_index], stays[cheapest.stay_index]
            if (
                mine.rating is not None
                and base.rating is not None
                and mine.rating - base.rating >= MIN_STAY_RATING_GAIN
            ):
                reasons.append(
                    TripReason(
                        code="better_rated_stay",
                        vs="cheapest",
                        amount=extra,
                        rating=mine.rating - base.rating,
                    )
                )
            near, far = mine.distance_to_center_km, base.distance_to_center_km
            if near is not None and far is not None and far - near >= MIN_STAY_DISTANCE_GAIN_KM:
                reasons.append(
                    TripReason(code="closer_stay", vs="cheapest", amount=extra, km=far - near)
                )
            if combo.full_nights > cheapest.full_nights:
                reasons.append(
                    TripReason(
                        code="more_full_nights",
                        vs="cheapest",
                        count=combo.full_nights - cheapest.full_nights,
                    )
                )
        if (
            comfort is not None
            and comfort.key != combo.key
            and combo.money_total < comfort.money_total
        ):
            longer = (
                combo.travel_min - comfort.travel_min
                if combo.travel_min is not None and comfort.travel_min is not None
                else None
            )
            reasons.append(
                TripReason(
                    code="cheaper_than_comfort",
                    vs="comfort",
                    amount=comfort.money_total - combo.money_total,
                    minutes=longer if longer and longer > 0 else None,
                )
            )
        if combo.full_nights == combo.window.nights and not combo.warnings:
            reasons.append(TripReason(code="all_nights_full", count=combo.full_nights))
        if budget is not None:
            left = Decimal(budget) - combo.money_total
            reasons.append(
                TripReason(code="within_budget", amount=left)
                if left >= 0
                else TripReason(code="over_budget", amount=-left)
            )
        return combo.model_copy(update={"reasons": reasons})

    return explain


# --- для розмови (модуль 9a): вибір кодом, не моделлю -----------------------------------


def current_combo(result: TripSearchResult) -> TripCombo | None:
    """«Ваша поїздка», а без вибору — рекомендований сценарій (Оптимальний, якщо є)."""
    if result.selected is not None:
        return result.selected
    order = {"best_value": 0, "cheapest": 1, "comfort": 2}
    picks = sorted(result.picks, key=lambda p: order[p.label])
    combos = {c.key: c for c in result.combos}
    return next((combos[p.combo_key] for p in picks if p.combo_key in combos), None)


def pick_flight(result: TripSearchResult, current: TripCombo, preference: str) -> str | None:
    """Кращий за побажанням рейс серед варіантів пошуку; None — кращого немає."""
    offers = {offer_key(o): o for o in result.offers}
    now = offers.get(current.offer_key)
    best: tuple[tuple[Decimal, Decimal], str] | None = None
    for option in result.flight_options:
        offer = offers.get(option.offer_key)
        if offer is None or option.offer_key == current.offer_key or option.window is None:
            continue
        stops = offer.outbound.stops + (offer.inbound.stops if offer.inbound else 0)
        minutes = offer.total_duration_min
        if preference == "cheaper":
            if option.flight_total >= current.flight_total:
                continue
            key = (option.flight_total, option.flight_total)
        elif preference == "faster":
            current_minutes = now.total_duration_min if now else None
            if minutes is None or (current_minutes is not None and minutes >= current_minutes):
                continue
            key = (Decimal(minutes), option.flight_total)
        elif preference == "fewer_stops":
            if stops >= current.stops:
                continue
            key = (Decimal(stops), option.flight_total)
        else:
            return None
        if best is None or key < best[0]:
            best = (key, option.offer_key)
    return best[1] if best else None


def pick_stay(result: TripSearchResult, current: TripCombo, preference: str) -> str | None:
    """Краще за побажанням житло на дати поточної поїздки; None — кращого немає. Тип житла
    не змінюємо: «дешевший готель» — не хостел (як і в «Знайти дешевший варіант»)."""
    now = result.stays[current.stay_index]
    best: tuple[tuple[Decimal, Decimal], str] | None = None
    for index in result.stay_options:
        stay = result.stays[index]
        key_str = stay_key(stay)
        if key_str == current.stay_key or stay.kind != now.kind:
            continue
        if preference == "cheaper":
            if stay.total_price >= current.stay_total:
                continue
            key = (stay.total_price, stay.total_price)
        elif preference == "closer_to_center":
            distance = stay.distance_to_center_km
            if distance is None or (
                now.distance_to_center_km is not None and distance >= now.distance_to_center_km
            ):
                continue
            key = (distance, stay.total_price)
        elif preference == "better_rating":
            if stay.rating is None or (now.rating is not None and stay.rating <= now.rating):
                continue
            key = (-stay.rating, stay.total_price)
        else:
            return None
        if best is None or key < best[0]:
            best = (key, key_str)
    return best[1] if best else None


def trip_snapshot(combo: TripCombo, offer: Offer, stay: Stay, priced_at: datetime) -> TripSnapshot:
    """Знімок для збереження й порівняння — як `tripSnapshot` у вебі."""
    back = offer.inbound
    return TripSnapshot(
        money_total=combo.money_total,
        confirmed=combo.costs.confirmed,
        approximate=combo.costs.approximate,
        unknown=combo.costs.unknown,
        currency=combo.currency,
        check_in=combo.window.check_in,
        check_out=combo.window.check_out,
        nights=combo.window.nights,
        flight=TripFlightSnapshot(
            origin=offer.outbound.origin,
            destination=offer.outbound.destination,
            departure_at=offer.outbound.departure_at,
            arrival_at=offer.outbound.arrival_at,
            return_departure_at=combo.return_departure_at,
            return_arrival_at=back.arrival_at if back else None,
            stops=combo.stops,
            duration_min=offer.total_duration_min,
            airlines=offer.airlines[:8],
            price=offer.price,
            price_status=offer.price_status,
        ),
        stay=TripStaySnapshot(
            name=stay.name[:200],
            kind=stay.kind,
            rating=float(stay.rating) if stay.rating is not None else None,
            review_count=stay.review_count,
            district=stay.district[:100] if stay.district else None,
            distance_to_center_km=float(stay.distance_to_center_km)
            if stay.distance_to_center_km is not None
            else None,
            cancellation=stay.cancellation,
            total_price=stay.total_price,
        ),
        priced_at=priced_at,
    )
