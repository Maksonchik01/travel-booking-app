import type { DateOption } from "@tickets/shared";

import { type SearchState, toSearchParams } from "@/lib/search-params";

/** Поріг підказки (як у поїздці, ADR 0048): економія не менше 10 одиниць і 5 % ціни. */
const MIN_SAVING = 10;
const MIN_SHARE = 0.05;

export type DateHint = {
  option: DateOption;
  saving: number;
  /** Зсув вильоту в днях: від’ємний — раніше. */
  shift: number;
  href: string;
};

/**
 * «Виліт на день раніше дешевший на 42 €» (етап 4): з уже знайдених варіантів дат (±дні),
 * відносно саме запитаної пари дат. Немає ціни на запитані дати — підказки немає.
 */
export function cheaperDateHint(options: DateOption[], state: SearchState): DateHint | null {
  const { query } = state;
  const base = options.find(
    (o) =>
      o.departure === query.departure_date &&
      (o.return_date ?? null) === (query.return_date ?? null),
  );
  if (!base) return null;
  const threshold = Math.max(MIN_SAVING, base.price * MIN_SHARE);
  const cheaper = options
    .filter((o) => o.currency === base.currency && base.price - o.price >= threshold)
    .sort((a, b) => a.price - b.price)[0];
  if (!cheaper) return null;
  const shift = Math.round(
    (Date.parse(`${cheaper.departure}T00:00:00Z`) - Date.parse(`${base.departure}T00:00:00Z`)) /
      86_400_000,
  );
  const href = `/?${toSearchParams({
    ...state,
    query: {
      ...query,
      departure_date: cheaper.departure,
      return_date: cheaper.return_date ?? null,
      flex_days: 0,
      departure_until: null,
      min_nights: null,
      max_nights: null,
      weekends: false,
    },
  })}`;
  return { option: cheaper, saving: base.price - cheaper.price, shift, href };
}
