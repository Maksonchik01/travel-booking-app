/**
 * Час вильоту/прильоту показуємо в поясі аеропорту — так, як його дав провайдер
 * ("2026-11-10T06:15:00+01:00" → 06:15), без перерахунку в пояс браузера.
 */
export function localTime(iso: string): string {
  return iso.slice(11, 16);
}

export function localDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Різниця в календарних днях між датами прильоту і вильоту (для позначки «+1»). */
export function dayShift(departureIso: string, arrivalIso: string): number {
  const dep = Date.parse(`${localDate(departureIso)}T00:00:00Z`);
  const arr = Date.parse(`${localDate(arrivalIso)}T00:00:00Z`);
  return Math.round((arr - dep) / 86_400_000);
}

export function splitDuration(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** Скільки повних годин минуло (для «ціна знайдена N год тому»). */
export function hoursAgo(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000));
}

/** Скільки календарних днів минуло від дати (YYYY-MM-DD) до `now` (за UTC). */
export function daysAgo(isoDate: string, now: Date): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - then) / 86_400_000));
}
