import type {
  ExploreDestination,
  ExploreQuery,
  FavoriteBody,
  FavoriteDestinationInput,
  FavoriteFlightInput,
  FavoriteKind,
  FavoriteStayInput,
  FavoriteTripInput,
  FlightQuery,
  Offer,
  Stay,
  StayQuery,
} from "@tickets/shared";

/**
 * «В обране» (модуль 7; 10a — три категорії: квитки, житло, поїздки). Структурований знімок:
 * параметри пропозиції (рядок URL пошуку, ідентифікатор, дати) і час отримання ціни — не лише
 * ціна. Гість — у цьому браузері (localStorage), з акаунтом — у профілі (після входу локальне
 * переноситься туди). Ціна знімка — історична; актуальну дає «Повторити пошук».
 */
export const MAX_FAVORITES = 200;
const STORAGE_KEY = "tickets.favorites.v1";

export type FavoriteItem = {
  item_key: string;
  kind: FavoriteKind;
  created_at: string;
  stay?: FavoriteStayInput | null;
  flight?: FavoriteFlightInput | null;
  trip?: FavoriteTripInput | null;
  destination?: FavoriteDestinationInput | null;
};

export function favoriteKey(
  stay: Pick<FavoriteStayInput, "source" | "stay_id" | "check_in" | "check_out">,
): string {
  return `${stay.source}:${stay.stay_id}|${stay.check_in}|${stay.check_out}`;
}

/** Ключ запису будь-якої категорії — як `item_key` в API. */
export function bodyKey(body: FavoriteBody): string {
  if (body.kind === "flight" && body.flight) return `${body.flight.source}:${body.flight.offer_id}`;
  if (body.kind === "destination" && body.destination) {
    const d = body.destination;
    return `dest|${d.code}|${d.depart}|${d.back}`;
  }
  if (body.kind === "trip" && body.trip) {
    const { query, snapshot } = body.trip;
    return `trip|${query.flight ?? null}|${query.stay ?? null}|${snapshot.check_in}`;
  }
  return favoriteKey(body.stay!);
}

export function toBody(item: FavoriteItem): FavoriteBody {
  return {
    kind: item.kind,
    stay: item.stay,
    flight: item.flight,
    trip: item.trip,
    destination: item.destination,
  };
}

/** Знімок житла для збереження: лише поля картки, без посилань продавців. */
export function favoriteSnapshot(stay: Stay, query: StayQuery, params: string): FavoriteStayInput {
  return {
    source: stay.source,
    stay_id: stay.id,
    name: stay.name,
    kind: stay.kind,
    city: query.city,
    district: stay.district ?? null,
    rating: stay.rating ?? null,
    review_count: stay.review_count ?? 0,
    price_per_night: stay.price_per_night,
    total_price: stay.total_price,
    currency: stay.currency,
    check_in: query.check_in,
    check_out: query.check_out,
    price_at: stay.found_at ?? stay.collected_at,
    params,
  };
}

/** Знімок авіаквитка: рейс, маршрут, час, склад, ціна з часом отримання й рядок пошуку. */
export function flightFavorite(offer: Offer, query: FlightQuery, params: string): FavoriteBody {
  const passengers = query.passengers ?? {};
  return {
    kind: "flight",
    flight: {
      source: offer.source,
      offer_id: offer.id,
      origin: offer.outbound.origin,
      destination: offer.outbound.destination,
      departure_at: offer.outbound.departure_at,
      arrival_at: offer.outbound.arrival_at ?? null,
      return_departure_at: offer.inbound?.departure_at ?? null,
      return_arrival_at: offer.inbound?.arrival_at ?? null,
      stops: offer.stops ?? offer.outbound.stops,
      duration_min: offer.total_duration_min ?? null,
      airlines: offer.airlines.slice(0, 8),
      passengers: Math.max(
        1,
        (passengers.adults ?? 1) + (passengers.children ?? 0) + (passengers.infants_in_seat ?? 0),
      ),
      price: offer.price,
      currency: offer.currency,
      price_status: offer.price_status ?? "cached",
      price_at: offer.found_at ?? offer.collected_at,
      params,
    },
  };
}

/** Напрямок з Explore (етап 7): місто, дати, ціна з часом отримання й рядок пошуку Explore. */
export function destinationFavorite(
  destination: ExploreDestination,
  query: ExploreQuery,
  params: string,
): FavoriteBody {
  const offer = destination.offer;
  const withStay = query.mode === "trip" && destination.total != null;
  return {
    kind: "destination",
    destination: {
      code: destination.code,
      city: destination.city_name,
      country: destination.country || null,
      depart: offer.outbound.departure_at.slice(0, 10),
      back: (offer.inbound?.departure_at ?? offer.outbound.departure_at).slice(0, 10),
      nights: destination.nights,
      price: withStay ? destination.total! : offer.price,
      with_stay: withStay,
      currency: offer.currency,
      price_at: offer.found_at ?? offer.collected_at,
      photo_url: destination.photo?.url ?? null,
      params,
    },
  };
}

function isItem(value: unknown): value is FavoriteItem {
  if (!value || typeof value !== "object") return false;
  const item = value as FavoriteItem;
  return (
    typeof item.item_key === "string" &&
    typeof item.created_at === "string" &&
    !!(item.stay || item.flight || item.trip || item.destination)
  );
}

export function readLocalFavorites(): FavoriteItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isItem)
      .map((i) => ({ ...i, kind: i.kind ?? "stay" })) // записи модуля 7 — житло
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function writeLocalFavorites(items: FavoriteItem[]): void {
  try {
    if (items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим: обране — лише до перезавантаження (або в профілі).
  }
}
