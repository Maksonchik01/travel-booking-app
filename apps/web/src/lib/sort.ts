import type { Offer, OfferScore, Stay, StayScore } from "@tickets/shared";

import type { SortKey } from "@/lib/search-params";
import type { StaySortKey } from "@/lib/stay-params";

/**
 * Сортування видачі (модуль 21: окремо, щоб тестувати). API віддає пропозиції від дешевших за
 * порівнюваною вартістю (валюта пошуку, потрібний багаж — модуль 22.5); «швидші», «виліт» і
 * «вигідніші» — тут. Невідоме (тривалість, оцінка) — у кінці, а не попереду.
 */
export function sortOffers(
  offers: Offer[],
  sort: SortKey,
  scores: Map<string, OfferScore>,
): Offer[] {
  if (sort === "price") return offers;
  if (sort === "score") {
    // Неоцінені (невідома тривалість, інша валюта) — в кінець, між собою за ціною.
    const total = (o: Offer) =>
      scores.get(`${o.source}:${o.id}`)?.breakdown.total ?? Number.POSITIVE_INFINITY;
    return [...offers].sort((a, b) => total(a) - total(b) || a.price - b.price);
  }
  if (sort === "departure") {
    // Місцевий час вильоту з ISO-рядка (як на картці), рівні — за ціною (сортування стабільне).
    const local = (o: Offer) => o.outbound.departure_at.slice(0, 16);
    return [...offers].sort((a, b) => local(a).localeCompare(local(b)));
  }
  // Невідома тривалість — в кінець, щоб не вдавати, що варіант швидкий.
  return [...offers].sort(
    (a, b) =>
      (a.total_duration_min ?? Number.POSITIVE_INFINITY) -
        (b.total_duration_min ?? Number.POSITIVE_INFINITY) || a.price - b.price,
  );
}

export function sortStays(
  stays: Stay[],
  sort: StaySortKey,
  scores: Map<string, StayScore>,
): Stay[] {
  if (sort === "price") return stays;
  const score = (s: Stay) => scores.get(`${s.source}:${s.id}`);
  if (sort === "score") {
    const total = (s: Stay) => score(s)?.breakdown.total ?? Number.POSITIVE_INFINITY;
    return [...stays].sort((a, b) => total(a) - total(b) || a.price_per_night - b.price_per_night);
  }
  // Рейтинг — скоригований на кількість відгуків, як у скорингу.
  const rating = (s: Stay) => score(s)?.breakdown.adjusted_rating ?? -1;
  return [...stays].sort((a, b) => rating(b) - rating(a) || a.price_per_night - b.price_per_night);
}
