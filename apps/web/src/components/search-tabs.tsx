"use client";

import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { OPEN_CHAT_EVENT } from "@/lib/ai-events";

export type SearchTab = "form" | "chat";
/** Перемикач режимів (`search-modes.tsx`) просить вкладку — подія на спільному контейнері. */
export const SELECT_TAB_EVENT = "search:select-tab";
/** Вкладка змінилась — перемикач підсвічує «ШІ-пошук» чи режим форми. */
export const TAB_CHANGED_EVENT = "search:tab-changed";
export const SEARCH_AREA_ATTR = "data-search-area";
/** На `<html>`, поки панель відкрита: на широкому екрані сторінка звільняє їй місце (globals.css). */
export const CHAT_OPEN_ATTR = "data-chat-open";
/** Ширина, з якої панель стоїть збоку від сторінки, а не шторкою поверх (Tailwind `lg`). */
const SIDE_PANEL_QUERY = "(min-width: 64rem)";

/**
 * Форма пошуку й ШІ-помічник (модуль 23a). Форма завжди на місці; помічник — бічна панель (на
 * телефоні — нижня шторка), а не блок над результатами. Відкривають її «ШІ-пошук» у перемикачі
 * режимів, плаваюча кнопка «ШІ-помічник» і «Оптимізувати з ШІ» (`OPEN_CHAT_EVENT`).
 *
 * Сама не відкривається: на новій сторінці (інший режим, перехід із форми) — згорнута, лише
 * кнопка. На телефоні згортається й тоді, коли помічник відкрив результати, — щоб їх було
 * видно; розмова лишається (вона в sessionStorage, панель змонтована).
 */
export function SearchTabs({ form, chat }: { form: ReactNode; chat: ReactNode }) {
  const t = useTranslations("ai");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // Перемикач режимів підсвічує «ШІ-пошук», поки панель відкрита.
  useEffect(() => {
    root.current
      ?.closest(`[${SEARCH_AREA_ATTR}]`)
      ?.dispatchEvent(
        new CustomEvent<SearchTab>(TAB_CHANGED_EVENT, { detail: open ? "chat" : "form" }),
      );
    const html = document.documentElement;
    if (open) html.setAttribute(CHAT_OPEN_ATTR, "");
    else html.removeAttribute(CHAT_OPEN_ATTR);
    return () => html.removeAttribute(CHAT_OPEN_ATTR);
  }, [open]);

  useEffect(() => {
    const area = root.current?.closest(`[${SEARCH_AREA_ATTR}]`);
    const onSelect = (event: Event) => setOpen((event as CustomEvent<SearchTab>).detail === "chat");
    const onOpen = () => {
      if (pathname !== window.location.pathname) return; // прихована попередня сторінка
      setOpen(true);
    };
    area?.addEventListener(SELECT_TAB_EVENT, onSelect);
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => {
      area?.removeEventListener(SELECT_TAB_EVENT, onSelect);
      window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
    };
  }, [pathname]);

  // Нові результати на телефоні — шторку згортаємо, щоб їх було видно (стан під час рендеру,
  // а не в ефекті; на сервері гілка не виконується — пошук ще не змінювався).
  const [seenSearch, setSeenSearch] = useState(search);
  if (seenSearch !== search) {
    setSeenSearch(search);
    if (open && !window.matchMedia(SIDE_PANEL_QUERY).matches) setOpen(false);
  }

  // Відкрили — фокус у поле повідомлення; Escape згортає.
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>("#ai-message, textarea")
      ?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      launcher.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={root} className="grid scroll-mt-20 gap-5">
      <div data-testid="search-panel-form">{form}</div>

      {open && (
        <div
          aria-hidden
          className="animate-in fade-in-0 fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={panel}
        hidden={!open}
        aria-label={t("panelTitle")}
        data-testid="search-panel-chat"
        className={
          "bg-card fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-t shadow-2xl " +
          "animate-in slide-in-from-bottom-4 lg:slide-in-from-right-4 duration-200 " +
          "lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-[26rem] lg:rounded-none lg:border-t-0 lg:border-l"
        }
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <header
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="bg-primary/10 text-primary grid size-7 place-items-center rounded-lg">
              <Sparkles className="size-4" aria-hidden />
            </span>
            {t("panelTitle")}
          </h2>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              launcher.current?.focus();
            }}
            aria-label={t("closeChat")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-9 place-items-center rounded-lg transition-colors"
            data-testid="chat-close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {chat}
        </div>
      </aside>

      {!open && (
        <button
          ref={launcher}
          type="button"
          onClick={() => setOpen(true)}
          className="chat-launcher bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90 fixed right-4 z-40 flex h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold shadow-lg transition-transform hover:-translate-y-0.5 active:translate-y-0 sm:right-6"
          data-testid="chat-launcher"
        >
          <Sparkles className="size-4" aria-hidden />
          {t("openChat")}
        </button>
      )}
    </div>
  );
}
