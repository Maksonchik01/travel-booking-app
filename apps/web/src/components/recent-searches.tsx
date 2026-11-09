"use client";

import { BedDouble, History, Luggage, Plane, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  clearRecent,
  type RecentKind,
  type RecentSearch,
  readRecent,
  recentHref,
  rememberSearch,
} from "@/lib/recent-searches";

const ICONS = { flights: Plane, stays: BedDouble, trip: Luggage } as const;

/** Запам'ятати відкритий пошук (сторінка результатів) — у цьому браузері. */
export function RememberSearch({
  kind,
  params,
  title,
}: {
  kind: RecentKind;
  params: string;
  title: string;
}) {
  useEffect(() => rememberSearch({ kind, params, title }), [kind, params, title]);
  return null;
}

/** «Останні пошуки» на головних сторінках режимів: повторити одним кліком (модуль 20.3). */
export function RecentSearches() {
  const t = useTranslations("recent");
  const [items, setItems] = useState<RecentSearch[]>([]);
  // Сховище браузера — лише після гідратації (на сервері його немає).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setItems(readRecent()), []);
  if (items.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="recent-title" data-testid="recent-searches">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recent-title" className="flex items-center gap-2 text-sm font-semibold">
          <History className="text-primary size-4" aria-hidden />
          {t("title")}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            clearRecent();
            setItems([]);
          }}
        >
          {t("clear")}
        </Button>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const Icon = ICONS[item.kind];
          return (
            <li key={`${item.kind}:${item.params}`}>
              <Link
                href={recentHref(item)}
                className="bg-card hover:border-primary/40 flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors"
                data-testid="recent-search"
              >
                <Icon className="text-primary size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
                  <Search className="size-3" aria-hidden />
                  {t("again")}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground text-xs">{t("hint")}</p>
    </section>
  );
}
