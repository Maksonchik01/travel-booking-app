import type { SearchKind } from "@tickets/shared";

/** Сторінка результатів кожного виду пошуку (історія кабінету, збережені гостем). */
export const KIND_PATH: Record<SearchKind, string> = {
  flights: "/",
  stays: "/stays",
  trip: "/trip",
  explore: "/explore",
};
