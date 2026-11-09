// Лише для сервера: next/headers недоступний у клієнтському коді.
import { headers } from "next/headers";

import { recordEvent } from "@/lib/api";
import type { EventName, EventProps } from "@/lib/analytics";

type Mode = "flights" | "stays" | "trip";
type Outcome = { ok: true; results: number } | { ok: false; reason: string };

/** Браузер просить не відстежувати (Sec-GPC / DNT) — серверні події теж не пишемо. */
function allowedBy(h: Headers): boolean {
  return h.get("sec-gpc") !== "1" && h.get("dnt") !== "1";
}

async function allowed(): Promise<boolean> {
  return allowedBy(await headers());
}

function bucket(count: number): string {
  if (count <= 0) return "0";
  if (count <= 5) return "1-5";
  if (count <= 20) return "6-20";
  return "21+";
}

/**
 * Пошук на сторінці результатів (модуль 19): «почато» й результат — успіх (кількість кошиком),
 * порожньо чи помилка (код). Заголовки читаємо зараз; надсилання — у `after`, після відповіді.
 */
export async function searchEvents(mode: Mode, outcome: Outcome): Promise<() => Promise<void>> {
  if (!(await allowed())) return async () => {};
  const events: [EventName, EventProps][] = [["search_started", { mode }]];
  if (!outcome.ok) events.push(["search_failed", { mode, reason: outcome.reason }]);
  else if (outcome.results === 0) events.push(["search_empty", { mode }]);
  else events.push(["search_succeeded", { mode, results: bucket(outcome.results) }]);
  return async () => {
    await Promise.all(events.map(([name, props]) => recordEvent({ name, props })));
  };
}

/** Подія з обробника маршруту (перехід до продавця): заголовки — із самого запиту. */
export function routeEvent(
  requestHeaders: Headers,
  name: EventName,
  props: EventProps,
): () => Promise<void> {
  if (!allowedBy(requestHeaders)) return async () => {};
  return () => recordEvent({ name, props });
}
