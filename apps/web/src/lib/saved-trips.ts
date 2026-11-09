import type {
  Offer,
  SavedTrip,
  SavedTripBody,
  Stay,
  TripCombo,
  TripQuery,
  TripSnapshotInput,
  TripStatus,
} from "@tickets/shared";

/**
 * Збережені поїздки (модуль 8c): запит з обраним рейсом і житлом + знімок того, що людина
 * бачила. Гість — у localStorage цього браузера, з акаунтом — у профілі (після входу локальні
 * переносяться туди). Ціни знімка — історичні: актуальні дає лише «Оновити ціни».
 */
export const MAX_SAVED_TRIPS = 50;
const STORAGE_KEY = "tickets.savedTrips.v1";

export type SavedTripItem = Pick<SavedTrip, "id" | "title" | "created_at" | "updated_at"> & {
  query: TripQuery;
  snapshot: TripSnapshotInput;
  /** Чернетка / запланована / архівна (модуль 10a); старі записи браузера — чернетки. */
  status?: TripStatus;
};

export const TRIP_STATUSES: readonly TripStatus[] = ["draft", "planned", "archived"];

/** Знімок «Вашої поїздки» чи сценарію: лише те, що потрібно для списку й порівняння. */
export function tripSnapshot(
  combo: TripCombo,
  offer: Offer,
  stay: Stay,
  pricedAt: string,
): TripSnapshotInput {
  return {
    money_total: combo.money_total,
    confirmed: combo.costs.confirmed,
    approximate: combo.costs.approximate,
    unknown: combo.costs.unknown,
    currency: combo.currency,
    check_in: combo.window.check_in,
    check_out: combo.window.check_out,
    nights: combo.window.nights,
    flight: {
      origin: offer.outbound.origin,
      destination: offer.outbound.destination,
      departure_at: offer.outbound.departure_at,
      arrival_at: offer.outbound.arrival_at ?? null,
      return_departure_at: combo.return_departure_at,
      return_arrival_at: offer.inbound?.arrival_at ?? null,
      stops: combo.stops,
      duration_min: offer.total_duration_min ?? null,
      airlines: offer.airlines.slice(0, 8),
      price: offer.price,
      price_status: offer.price_status ?? "cached",
    },
    stay: {
      name: stay.name,
      kind: stay.kind,
      rating: stay.rating ?? null,
      review_count: stay.review_count ?? 0,
      district: stay.district ?? null,
      distance_to_center_km: stay.distance_to_center_km ?? null,
      cancellation: stay.cancellation ?? null,
      total_price: stay.total_price,
    },
    priced_at: pricedAt,
  };
}

/** Запит, що відкриє саме цю конфігурацію (рейс + житло). */
export function pinnedQuery(query: TripQuery, combo: TripCombo): TripQuery {
  return { ...query, flight: combo.offer_key, stay: combo.stay_key };
}

export function savedBody(item: SavedTripItem): SavedTripBody {
  return {
    title: item.title,
    query: item.query,
    snapshot: item.snapshot,
    status: item.status ?? "draft",
  };
}

function isItem(value: unknown): value is SavedTripItem {
  if (!value || typeof value !== "object") return false;
  const item = value as SavedTripItem;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    !!item.query &&
    typeof item.query.origin === "string" &&
    !!item.snapshot &&
    typeof item.snapshot.money_total === "number"
  );
}

export function readLocalTrips(): SavedTripItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, MAX_SAVED_TRIPS) : [];
  } catch {
    return [];
  }
}

export function writeLocalTrips(items: SavedTripItem[]): void {
  try {
    if (items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим: збережене — лише до перезавантаження (або в профілі).
  }
}
