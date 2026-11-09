"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { OPEN_CHAT_EVENT } from "@/lib/ai-events";
import { readStore } from "@/lib/chat-history";
import { useHydrated } from "@/lib/use-hydrated";

export type SearchTab = "form" | "chat";
const TAB_STORAGE_KEY = "tickets.searchTab";
/** Перемикач режимів (`search-modes.tsx`) просить вкладку — подія на спільному контейнері. */
export const SELECT_TAB_EVENT = "search:select-tab";
/** Вкладка змінилась — перемикач підсвічує «ШІ-пошук» чи режим форми. */
export const TAB_CHANGED_EVENT = "search:tab-changed";
export const SEARCH_AREA_ATTR = "data-search-area";

/** Вкладка з sessionStorage; якщо не обирали — чат, коли є відкрита розмова. */
function restoreTab(): SearchTab {
  try {
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved === "form" || saved === "chat") return saved;
    return readStore().activeId ? "chat" : "form";
  } catch {
    return "form";
  }
}

/**
 * Два способи шукати в одній картці: форма (за замовчуванням, працює без JS) і ШІ-помічник.
 * Обидві панелі лишаються змонтованими — перемикання не губить введене. Вибирає вкладку
 * перемикач режимів над карткою (модуль 12.2) — подіями на спільному контейнері сторінки.
 */
export function SearchTabs(props: { form: ReactNode; chat: ReactNode }) {
  const hydrated = useHydrated();
  return <Tabs key={hydrated ? "restored" : "server"} restored={hydrated} {...props} />;
}

function Tabs({ form, chat, restored }: { form: ReactNode; chat: ReactNode; restored: boolean }) {
  const [tab, setTab] = useState<SearchTab>(() => (restored ? restoreTab() : "form"));
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Повідомити перемикач про поточну вкладку (і після відновлення з sessionStorage).
  useEffect(() => {
    root.current
      ?.closest(`[${SEARCH_AREA_ATTR}]`)
      ?.dispatchEvent(new CustomEvent<SearchTab>(TAB_CHANGED_EVENT, { detail: tab }));
  }, [tab]);

  useEffect(() => {
    const area = root.current?.closest(`[${SEARCH_AREA_ATTR}]`);
    const select = (next: SearchTab) => {
      setTab(next);
      try {
        sessionStorage.setItem(TAB_STORAGE_KEY, next);
      } catch {
        // без сховища вкладка просто не запам'ятовується
      }
    };
    const onSelect = (event: Event) => select((event as CustomEvent<SearchTab>).detail);
    // «Оптимізувати з ШІ» з планувальника — на вкладку помічника й до неї прокрутити.
    const onOpen = () => {
      if (pathname !== window.location.pathname) return; // прихована попередня сторінка
      select("chat");
      root.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    area?.addEventListener(SELECT_TAB_EVENT, onSelect);
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => {
      area?.removeEventListener(SELECT_TAB_EVENT, onSelect);
      window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
    };
  }, [pathname]);

  return (
    <div ref={root} className="grid scroll-mt-20 gap-5">
      <div hidden={tab !== "form"} data-testid="search-panel-form">
        {form}
      </div>
      <div hidden={tab !== "chat"} data-testid="search-panel-chat">
        {chat}
      </div>
    </div>
  );
}
