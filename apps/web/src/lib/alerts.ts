import type { AlertCreate, AlertView, FlightQuery, StayQuery, TripQuery } from "@tickets/shared";

/**
 * Сторінка результатів для підписки (модуль 11a) — та сама логіка, що й у посиланні з
 * повідомлення (`AlertService.search_url`), але без знайдених дат.
 */
export function alertSearchHref(alert: AlertView): string {
  if (alert.kind === "stay") {
    const params = new URLSearchParams({
      city: alert.destination,
      in: alert.departure_date,
      out: alert.return_date ?? "",
      adults: String(alert.adults),
    });
    return `/stays?${params}`;
  }
  const params = new URLSearchParams({ from: alert.origin ?? "", to: alert.destination });
  params.set("depart", alert.departure_date);
  if (alert.kind === "flex" && alert.departure_until) {
    params.set("flex", "range");
    params.set("until", alert.departure_until);
    params.set("nmin", String(alert.min_nights ?? 1));
    params.set("nmax", String(alert.max_nights ?? alert.min_nights ?? 1));
  } else if (alert.return_date) {
    params.set("return", alert.return_date);
  }
  if (alert.adults > 1) params.set("adults", String(alert.adults));
  if (alert.baggage && alert.baggage !== "none") params.set("bag", alert.baggage);
  return `${alert.kind === "trip" ? "/trip" : "/"}?${params}`;
}

/** Що відстежуємо (модуль 11a): тип, параметри підписки без умови й каналу. */
export type AlertTarget = {
  kind: AlertKind;
  base: Omit<AlertCreate, "condition" | "threshold" | "percent" | "channel" | "email" | "weekends">;
  /** Ключ для позначки «стежите» в цьому браузері. */
  key: string;
  title: { from: string; to: string };
};
export type AlertKind = NonNullable<AlertCreate["kind"]>;

/**
 * Підписка з пошуку перельотів. Перевірки йдуть за кешованими цінами дорослих в економі
 * (ADR 0010, 0013): діти, немовлята чи інший клас — null (підписку не пропонуємо). Період
 * вильоту з ночами — «гнучкі дати»; період без ночей у туди-назад — тривалість поїздки;
 * період в один бік — null.
 */
export function flightTarget(query: FlightQuery): AlertTarget | null {
  const p = query.passengers;
  if (p?.children || p?.infants || p?.infants_in_seat) return null;
  if ((query.cabin ?? "economy") !== "economy") return null;
  const common = {
    origin: query.origin,
    destination: query.destination,
    departure_date: query.departure_date,
    adults: p?.adults ?? 1,
    baggage: query.baggage ?? "none",
    currency: query.currency ?? "EUR",
  };
  const title = { from: query.origin, to: query.destination };
  if (query.departure_until) {
    const days = query.return_date
      ? Math.round((Date.parse(query.return_date) - Date.parse(query.departure_date)) / 86_400_000)
      : 0;
    const min = query.min_nights ?? days;
    if (!min) return null;
    const max = query.max_nights ?? min;
    return {
      kind: "flex",
      base: {
        ...common,
        kind: "flex",
        departure_until: query.departure_until,
        min_nights: min,
        max_nights: max,
      },
      key: [
        query.origin,
        query.destination,
        query.departure_date,
        query.departure_until,
        min,
        max,
      ].join("|"),
      title,
    };
  }
  return {
    kind: "flight",
    base: { ...common, kind: "flight", return_date: query.return_date ?? null },
    key: [query.origin, query.destination, query.departure_date, query.return_date ?? ""].join("|"),
    title,
  };
}

/** Підписка з пошуку житла: будь-яка пропозиція в місті на ці дати. */
export function stayTarget(query: StayQuery): AlertTarget {
  return {
    kind: "stay",
    base: {
      kind: "stay",
      destination: query.city,
      departure_date: query.check_in,
      return_date: query.check_out,
      adults: query.guests?.adults ?? 2,
      baggage: "none",
      currency: query.currency ?? "EUR",
    },
    key: ["stay", query.city, query.check_in, query.check_out].join("|"),
    title: { from: query.city, to: query.city },
  };
}

/** Повна поїздка (переліт + житло) на конкретні дати; тривалість без дат — null. */
export function tripTarget(query: TripQuery): AlertTarget | null {
  if (!query.return_date) return null;
  return {
    kind: "trip",
    base: {
      kind: "trip",
      origin: query.origin,
      destination: query.destination,
      departure_date: query.departure_date,
      return_date: query.return_date,
      adults: query.adults ?? 2,
      baggage: query.baggage ?? "none",
      currency: query.currency ?? "EUR",
    },
    key: ["trip", query.origin, query.destination, query.departure_date, query.return_date].join(
      "|",
    ),
    title: { from: query.origin, to: query.destination },
  };
}
