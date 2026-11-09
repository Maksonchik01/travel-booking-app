"use client";

import { useEffect } from "react";

import { type EventName, propsFrom, track } from "@/lib/analytics";

/**
 * Делегований облік подій (модуль 19): елемент позначають `data-track="подія"` (+ мітки
 * `data-track-mode/kind/source`) — і серверні компоненти теж, без власного клієнтського коду.
 * Кнопка чи посилання — клік; форма — відправлення; <details> — розкриття.
 */
export function AnalyticsListener() {
  useEffect(() => {
    const fire = (element: Element | null) => {
      const name = element?.getAttribute("data-track") as EventName | null;
      if (element && name) track(name, propsFrom(element));
    };
    const onClick = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest("[data-track]");
      if (target && target.tagName !== "FORM" && target.tagName !== "DETAILS") fire(target);
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target as Element | null;
      if (form?.matches("form[data-track]")) fire(form);
    };
    const onToggle = (event: Event) => {
      const details = event.target as HTMLDetailsElement | null;
      if (details?.matches("details[data-track]") && details.open) fire(details);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("toggle", onToggle, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("toggle", onToggle, true);
    };
  }, []);
  return null;
}
