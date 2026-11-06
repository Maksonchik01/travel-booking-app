"use client";

import { Search, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

import { CHAT_MODE_KEY } from "@/components/ai-chat";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Tab = "form" | "chat";
const TABS: readonly Tab[] = ["form", "chat"];
const TAB_STORAGE_KEY = "tickets.searchTab";

/** Вкладка з sessionStorage; якщо не обирали — чат, коли в ньому вже обрано режим. */
function restoreTab(): Tab {
  try {
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved === "form" || saved === "chat") return saved;
    return sessionStorage.getItem(CHAT_MODE_KEY) ? "chat" : "form";
  } catch {
    return "form";
  }
}

/**
 * Два способи шукати в одній картці: форма (за замовчуванням, працює без JS) і ШІ-помічник.
 * Обидві панелі лишаються змонтованими — перемикання не губить введене.
 */
export function SearchTabs(props: { form: ReactNode; chat: ReactNode }) {
  const hydrated = useHydrated();
  return <Tabs key={hydrated ? "restored" : "server"} restored={hydrated} {...props} />;
}

function Tabs({ form, chat, restored }: { form: ReactNode; chat: ReactNode; restored: boolean }) {
  const t = useTranslations("tabs");
  const id = useId();
  const [tab, setTab] = useState<Tab>(() => (restored ? restoreTab() : "form"));
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ form: null, chat: null });

  function select(next: Tab, focus = false) {
    setTab(next);
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // без сховища вкладка просто не запам'ятовується
    }
    if (focus) refs.current[next]?.focus();
  }

  // Стрілки перемикають вкладки (ARIA tabs pattern).
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    select(TABS[(index + step + TABS.length) % TABS.length]!, true);
  }

  const icons = { form: Search, chat: Sparkles } as const;
  return (
    <div className="grid gap-5">
      <div
        role="tablist"
        aria-label={t("label")}
        onKeyDown={onKeyDown}
        className="bg-muted inline-flex w-full rounded-xl p-1 sm:w-fit"
      >
        {TABS.map((name) => {
          const Icon = icons[name];
          const selected = tab === name;
          return (
            <button
              key={name}
              ref={(el) => {
                refs.current[name] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-${name}-tab`}
              aria-selected={selected}
              aria-controls={`${id}-${name}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(name)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all sm:flex-none",
                selected
                  ? "bg-card text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-card/50",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t(name)}
            </button>
          );
        })}
      </div>
      {TABS.map((name) => (
        <div
          key={name}
          role="tabpanel"
          id={`${id}-${name}`}
          aria-labelledby={`${id}-${name}-tab`}
          hidden={tab !== name}
        >
          {name === "form" ? form : chat}
        </div>
      ))}
    </div>
  );
}
