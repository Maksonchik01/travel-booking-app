"use client";

import { BedDouble, Compass, Luggage, Plane, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  SEARCH_AREA_ATTR,
  SELECT_TAB_EVENT,
  type SearchTab,
  TAB_CHANGED_EVENT,
} from "@/components/search-tabs";
import { exploreFromCommon } from "@/lib/explore-params";
import {
  type CommonSearch,
  commonFrom,
  draftHref,
  modeHref,
  rememberSearch,
  returnHref,
  SEARCH_MODES,
  type SearchMode,
} from "@/lib/search-modes";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const ICONS = { flights: Plane, stays: BedDouble, trip: Luggage } as const;
const DRAFT_DELAY_MS = 400;

/**
 * Перемикач режимів пошуку (модуль 12.2): авіаквитки, житло, поїздка й ШІ-пошук — над однією
 * карткою на кожній сторінці пошуку. Перехід переносить спільне (куди, дати, люди) з поточної
 * форми — навіть ще не надісланої; без JS — посилання з параметрів поточного URL.
 * «ШІ-пошук» перемикає картку на помічника, не залишаючи сторінку.
 */
export function SearchModes({
  current,
  common,
  ai,
  drafting = false,
  children,
}: {
  /** "explore" — сторінка Explore (ADR 0045): окремий розділ поруч із режимами. */
  current: SearchMode | "explore";
  /** Результатів ще немає: введене у форму тримаємо в адресі (`draft=1`, модуль 20.4). */
  drafting?: boolean;
  /** Спільне з URL сторінки — для посилань без JS. */
  common: CommonSearch;
  /** Чи є ШІ-помічник (LLM увімкнено). */
  ai: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("modes");
  const router = useRouter();
  const area = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<SearchTab>("form");
  const hydrated = useHydrated();

  useEffect(() => {
    const node = area.current;
    const onChange = (event: Event) => setTab((event as CustomEvent<SearchTab>).detail);
    node?.addEventListener(TAB_CHANGED_EVENT, onChange);
    return () => node?.removeEventListener(TAB_CHANGED_EVENT, onChange);
  }, []);

  // Пошук із результатами — запам'ятати для повернення в цей розділ (модуль 23b).
  const search = useSearchParams().toString();
  useEffect(() => {
    if (current === "explore") return;
    if (!drafting && search) rememberSearch(current, `${window.location.pathname}?${search}`);
  }, [current, drafting, search]);

  // Чернетка форми — в адресу (без запису в історію): оновлення сторінки її не губить.
  useEffect(() => {
    const node = area.current;
    if (!node || !drafting || current === "explore") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onEdit = (event: Event) => {
      const form = (event.target as Element | null)?.closest("form[data-search-form]");
      if (!(form instanceof HTMLFormElement)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const href = draftHref(current, commonFrom(current, new FormData(form)));
        if (href !== `${window.location.pathname}${window.location.search}`) {
          window.history.replaceState(null, "", href);
        }
      }, DRAFT_DELAY_MS);
    };
    node.addEventListener("input", onEdit);
    node.addEventListener("change", onEdit);
    return () => {
      clearTimeout(timer);
      node.removeEventListener("input", onEdit);
      node.removeEventListener("change", onEdit);
    };
  }, [current, drafting]);

  function selectTab(next: SearchTab) {
    area.current?.dispatchEvent(new CustomEvent<SearchTab>(SELECT_TAB_EVENT, { detail: next }));
  }

  /** Спільне з ПОТОЧНОЇ форми (введене, але ще не надіслане), інакше — з URL. */
  function liveCommon(): CommonSearch {
    const form = area.current?.querySelector<HTMLFormElement>("form[data-search-form]");
    if (!form) return common;
    const fromForm = commonFrom(current === "explore" ? "flights" : current, new FormData(form));
    return Object.keys(fromForm).length ? fromForm : common;
  }

  function go(event: React.MouseEvent<HTMLAnchorElement>, mode: SearchMode) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (mode === current) {
      selectTab("form");
      return;
    }
    router.push(returnHref(mode, liveCommon()));
  }

  function goExplore(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (current === "explore") {
      selectTab("form");
      return;
    }
    router.push(exploreFromCommon(liveCommon()));
  }

  const item =
    "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-all disabled:opacity-60 sm:px-4";
  const on = "bg-card text-primary shadow-sm";
  const off = "text-muted-foreground hover:text-foreground hover:bg-card/50";

  return (
    <div ref={area} {...{ [SEARCH_AREA_ATTR]: "" }} className="grid gap-4">
      <nav
        aria-label={t("label")}
        className={cn("bg-muted grid grid-cols-2 gap-1 rounded-xl p-1 sm:flex sm:w-fit")}
        data-testid="search-modes"
      >
        {SEARCH_MODES.map((mode) => {
          const Icon = ICONS[mode];
          const active = mode === current && tab === "form";
          return (
            <Link
              key={mode}
              href={modeHref(mode, common)}
              onClick={(e) => go(e, mode)}
              aria-current={active ? "page" : undefined}
              className={cn(item, active ? on : off)}
            >
              <Icon className="size-4" aria-hidden />
              {t(mode)}
            </Link>
          );
        })}
        <Link
          href={exploreFromCommon(common)}
          onClick={goExplore}
          aria-current={current === "explore" && tab === "form" ? "page" : undefined}
          className={cn(item, current === "explore" && tab === "form" ? on : off)}
          data-testid="mode-explore"
        >
          <Compass className="size-4" aria-hidden />
          {t("explore")}
        </Link>
        {ai && (
          <button
            type="button"
            onClick={() => selectTab("chat")}
            aria-pressed={tab === "chat"}
            // Без JS помічник не працює — кнопка оживає після гідратації.
            disabled={!hydrated}
            className={cn(item, "col-span-2 sm:col-span-1", tab === "chat" ? on : off)}
          >
            <Sparkles className="size-4" aria-hidden />
            {t("ai")}
          </button>
        )}
      </nav>
      {children}
    </div>
  );
}
