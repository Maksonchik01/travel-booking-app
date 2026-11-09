import type { EventIn } from "@tickets/shared";

/**
 * Продуктова аналітика (модуль 19, ADR 0038): анонімні події — назва й кілька міток. Жодних
 * ідентифікаторів людини чи сесії, cookies, тексту запитів чи маршрутів. «Не відстежувати»
 * (Global Privacy Control / Do Not Track) — нічого не надсилаємо.
 */
export type EventName = EventIn["name"];
export type EventProps = NonNullable<EventIn["props"]>;

const ENDPOINT = "/api/events";

/** Браузер просить не відстежувати — поважаємо. */
export function trackingAllowed(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl !== true && nav.doNotTrack !== "1";
}

/** Надіслати подію у фоні: sendBeacon переживає перехід на іншу сторінку; збій — тиша. */
export function track(name: EventName, props: EventProps = {}): void {
  if (typeof window === "undefined" || !trackingAllowed()) return;
  const body = JSON.stringify({ name, props });
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // аналітика ніколи не ламає сторінку
  }
}

/** Мітки з data-атрибутів елемента: data-track-mode, data-track-kind, data-track-source. */
export function propsFrom(element: Element): EventProps {
  const props: EventProps = {};
  for (const key of ["mode", "kind", "source"] as const) {
    const value = element.getAttribute(`data-track-${key}`);
    if (value) props[key] = value;
  }
  return props;
}
