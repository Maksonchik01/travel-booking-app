/**
 * Швидкі дати (модуль 3 розширення) — спільні для перельотів, поїздки й Explore: найближчі й
 * наступні вихідні, вихідні місяця, 3–4 та 5–7 днів. Чисті функції від «сьогодні» (місцевий
 * день людини, YYYY-MM-DD): обчислюємо в обробнику кліку, а не під час рендеру.
 */
export type DatePreset = "thisWeekend" | "nextWeekend" | "monthWeekends" | "short" | "week";
export const DATE_PRESETS: readonly DatePreset[] = [
  "thisWeekend",
  "nextWeekend",
  "monthWeekends",
  "short",
  "week",
];
/** Короткі поїздки — шукаємо в наступні 30 днів від початку. */
const SHORT_WINDOW_DAYS = 30;

export type PresetDates = {
  depart: string;
  /** Точні дати (вихідні) — повернення. */
  back?: string;
  /** Гнучко — останній день вильоту, ночі й «лише вихідні». */
  until?: string;
  nights?: readonly [number, number];
  weekends?: boolean;
};

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Сьогодні за місцевим часом браузера (YYYY-MM-DD). */
export function localToday(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Дати пресета від `today`. `anchor` — уже обрана дата вильоту: «вихідні місяця» — того місяця
 * (якщо він не минув), короткі поїздки — від неї; без неї — наступний місяць / завтра.
 * Вихідні — виліт у п'ятницю, повернення в неділю; «вихідні місяця» — увесь місяць з 1–3 ночами.
 */
export function datePreset(preset: DatePreset, today: string, anchor?: string): PresetDates {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 — нд, 5 — пт
  // Сьогодні вже сб/нд — «найближчі» вихідні наступні.
  const friday = shiftDay(today, weekday === 6 ? 6 : weekday === 0 ? 5 : (5 - weekday + 7) % 7);
  const start = anchor && anchor > today ? anchor : shiftDay(today, 1);
  switch (preset) {
    case "thisWeekend":
      return { depart: friday, back: shiftDay(friday, 2) };
    case "nextWeekend":
      return { depart: shiftDay(friday, 7), back: shiftDay(friday, 9) };
    case "monthWeekends": {
      const base = new Date(`${anchor && anchor > today ? anchor : today}T00:00:00Z`);
      const offset = anchor && anchor > today ? 0 : 1;
      const year = base.getUTCFullYear();
      const month = base.getUTCMonth() + offset;
      const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
      return {
        depart: first > today ? first : shiftDay(today, 1),
        until: last,
        nights: [1, 3],
        weekends: true,
      };
    }
    case "short":
      return { depart: start, until: shiftDay(start, SHORT_WINDOW_DAYS), nights: [2, 3] };
    case "week":
      return { depart: start, until: shiftDay(start, SHORT_WINDOW_DAYS), nights: [4, 6] };
  }
}
