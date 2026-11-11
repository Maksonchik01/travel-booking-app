/**
 * Позиція довгого списку (етап 9): скільки карток розкрито («Показати ще») і де була прокрутка —
 * у sessionStorage вкладки за адресою сторінки. Відновлюємо лише після «Назад» (popstate):
 * новий пошук чи перехід за посиланням починається згори.
 */
const PREFIX = "tickets.listPos.";
const BACK_WINDOW_MS = 5_000;
let lastBack = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    lastBack = Date.now();
  });
}

export type ListPosition = { limit: number; y: number };

export function cameBack(now = Date.now()): boolean {
  return now - lastBack < BACK_WINDOW_MS;
}

export function readListPosition(key: string): ListPosition | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PREFIX + key) ?? "null") as unknown;
    const pos = raw as ListPosition | null;
    return pos && Number.isFinite(pos.limit) && Number.isFinite(pos.y) ? pos : null;
  } catch {
    return null;
  }
}

export function saveListPosition(key: string, pos: ListPosition): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(pos));
  } catch {
    // без сховища — просто без відновлення
  }
}
