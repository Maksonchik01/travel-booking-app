"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const DESKTOP = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** lg і ширше — бічна панель; вужче — окреме вікно фільтрів. */
function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  );
}

export type FilterMode = {
  /** Телефон: вікно фільтрів — застосовуємо кнопкою, а не на кожну зміну. */
  sheet: boolean;
  close: () => void;
};

/**
 * Оболонка фільтрів видачі (модуль 13.3). Десктоп — липка бічна панель, зміни застосовуються
 * одразу. Телефон — компактна кнопка «Фільтри · N» і окреме вікно з «Застосувати» / «Скинути»
 * знизу. Без JS — панель на сторінці, як раніше. Стан фільтрів — в URL, тож повернення до
 * результатів його не губить.
 */
export function FilterShell({
  titleId,
  count,
  testId,
  children,
}: {
  titleId: string;
  count: number;
  testId?: string;
  children: (mode: FilterMode) => ReactNode;
}) {
  const t = useTranslations("filters");
  const hydrated = useHydrated();
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sheetMode = hydrated && !desktop;

  const close = () => setOpen(false);
  const wasOpen = useRef(false);

  // Закрили вікно — фокус назад на кнопку «Фільтри».
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // Вікно відкрите: без прокрутки сторінки під ним, Escape закриває, фокус — на «Закрити».
  useEffect(() => {
    if (!open || !sheetMode) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, sheetMode]);

  const heading = (
    <h2 id={titleId} className="flex items-center gap-2 font-semibold">
      <SlidersHorizontal className="text-primary size-4" aria-hidden />
      {t("title")}
      {count > 0 && (
        <span
          className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
          data-testid="filters-count"
        >
          {count}
        </span>
      )}
    </h2>
  );

  if (!sheetMode) {
    return (
      <aside
        className="bg-card grid content-start gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        {heading}
        {children({ sheet: false, close })}
      </aside>
    );
  }

  return (
    <div data-testid={testId}>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        className="bg-card w-full justify-between"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-testid="filters-open"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="text-primary size-4" aria-hidden />
          {t("title")}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
            count > 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {count > 0 ? t("activeCount", { count }) : t("none")}
        </span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="bg-background animate-in fade-in-0 slide-in-from-bottom-4 fixed inset-0 z-50 flex flex-col duration-200"
          data-testid="filters-sheet"
        >
          <div className="flex items-center justify-between border-b px-4 py-3 [padding-top:max(0.75rem,env(safe-area-inset-top))]">
            {heading}
            <button
              ref={closeButton}
              type="button"
              onClick={close}
              aria-label={t("close")}
              className="hover:bg-muted grid size-10 place-items-center rounded-lg"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pt-4">{children({ sheet: true, close })}</div>
        </div>
      )}
    </div>
  );
}

/** Нижня панель дій у вікні фільтрів — завжди на виду (липка). */
export function SheetActions({ sheet, children }: { sheet: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        sheet &&
          "bg-background sticky bottom-0 -mx-4 border-t px-4 py-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]",
      )}
    >
      {children}
    </div>
  );
}
