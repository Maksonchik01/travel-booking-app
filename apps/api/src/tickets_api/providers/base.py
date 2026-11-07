"""Єдині інтерфейси джерел перельотів і житла. Скоринг, API і UI знають лише про них."""

from datetime import date
from typing import Protocol, runtime_checkable

from tickets_api.domain.flights import CalendarDay, FlightQuery, Offer
from tickets_api.domain.sellers import SellerOffer
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

    async def search(self, query: FlightQuery) -> list[Offer]:
        """Пропозиції для запиту. Порожній список — нічого не знайдено (це не помилка)."""
        ...

    async def calendar(
        self, origin: str, destination: str, month: date, currency: str
    ) -> list[CalendarDay]:
        """Найнижчі ціни по днях місяця (`month` — будь-яка дата цього місяця), в один бік."""
        ...


@runtime_checkable
class SellerSource(Protocol):
    """Необов'язкова здатність джерела: продавці рейсу й свіжа ціна в кожного (модуль 3)."""

    name: str

    async def sellers(self, query: FlightQuery, booking_ref: str) -> list[SellerOffer]:
        """Продавці для `Offer.booking_ref`. Не вміє — ProviderUnsupportedError."""
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
