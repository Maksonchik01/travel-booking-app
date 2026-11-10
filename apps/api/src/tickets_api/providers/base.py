"""Єдині інтерфейси джерел перельотів і житла. Скоринг, API і UI знають лише про них."""

from datetime import date
from typing import Protocol, runtime_checkable

from tickets_api.domain.flights import CalendarDay, FlightQuery, Offer
from tickets_api.domain.sellers import SellerOffer
from tickets_api.domain.stay_rates import StayRate
from tickets_api.domain.stays import Stay, StayQuery, StayReview


class ProviderError(Exception):
    """Провайдер не зміг відповісти. Повідомлення без секретів і сирих тіл відповіді."""

    def __init__(self, provider: str, message: str) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message


class ProviderRateLimitedError(ProviderError):
    pass


class ProviderUnsupportedError(ProviderError):
    """Джерело не може чесно відповісти на такий запит (склад пасажирів, клас) — ADR 0013.

    Не помилка джерела: ціну не вигадуємо (напр. не множимо дорослий тариф на дітей).
    `message` — код причини для UI: passengers | cabin.
    """


@runtime_checkable
class FlightProvider(Protocol):
    name: str
    # Провайдер може мати власний ліміт часу (атрибут `timeout_s`), інакше — загальний
    # PROVIDER_TIMEOUT_S. Див. FlightSearchService._call.
    # Атрибут `live = False` — ціни з кешу пошуків (Travelpayouts): такі джерела безкоштовні,
    # тож у гнучкому пошуку дають кандидатів дат для живих (`is_live`). Без атрибута — живе.

    async def search(self, query: FlightQuery) -> list[Offer]:
        """Пропозиції для запиту. Порожній список — нічого не знайдено (це не помилка)."""
        ...

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        """Найнижчі ціни по днях місяця (`month` — будь-яка дата цього місяця), в один бік."""
        ...


def is_live(provider: FlightProvider) -> bool:
    return bool(getattr(provider, "live", True))


@runtime_checkable
class SellerSource(Protocol):
    """Необов'язкова здатність джерела: продавці рейсу й свіжа ціна в кожного (модуль 3)."""

    name: str

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Продавці для `Offer.booking_ref`. Не вміє — ProviderUnsupportedError."""
        ...


@runtime_checkable
class ExploreSource(Protocol):
    """Необов'язкова здатність кешованого джерела: найдешевші квитки туди-назад з міста в усі
    напрямки (Explore, ADR 0045). Ціна — за одного дорослого в економі."""

    name: str

    async def explore(
        self, origin: str, departure: str, return_at: str | None, currency: str, *, direct: bool
    ) -> list[Offer]:
        """`departure` — YYYY-MM або YYYY-MM-DD; `return_at` — YYYY-MM-DD (точні дати) чи None."""
        ...


@runtime_checkable
class StayProvider(Protocol):
    """Єдиний інтерфейс джерел житла (як FlightProvider для перельотів)."""

    name: str

    async def search(self, query: StayQuery) -> list[Stay]:
        """Варіанти житла для запиту. Порожній список — нічого не знайдено (це не помилка)."""
        ...

    async def reviews(self, stay_id: str, *, limit: int = 30) -> list[StayReview]:
        """Свіжі відгуки про об'єкт (НЕДОВІРЕНИЙ текст). Порожньо — відгуків немає."""
        ...


class StayRateSource(Protocol):
    """Необов'язкова здатність джерела житла: тарифи різних продавців на об'єкт (модуль 7)."""

    name: str

    async def rates(self, query: StayQuery, stay_id: str) -> list[StayRate]:
        """Тарифи на дати й гостей запиту. Не вміє — ProviderUnsupportedError."""
        ...
