"use client";

import { Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { KIND_PATH } from "@/lib/search-kinds";
import { type GuestSearch, readGuestSearches, writeGuestSearches } from "@/lib/guest-searches";

/**
 * Збережені пошуки в цьому браузері (етап 7): гість зберігає без входу; з акаунтом — у кабінеті,
 * а локальні пропонуємо перенести (`GuestImportPrompt`). Порожньо — секції немає.
 */
export function GuestSearches() {
  const t = useTranslations("guestImport");
  const [items, setItems] = useState<GuestSearch[]>([]);

  useEffect(() => {
    // Сховище браузера — лише після гідратації.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(readGuestSearches());
  }, []);

  if (items.length === 0) return null;

  function remove(item: GuestSearch) {
    const next = items.filter((i) => !(i.kind === item.kind && i.params === item.params));
    writeGuestSearches(next);
    setItems(next);
  }

  return (
    <section
      id="searches"
      className="grid scroll-mt-20 gap-3"
      aria-labelledby="guest-searches-title"
    >
      <h2 id="guest-searches-title" className="text-lg font-semibold">
        {t("searchesTitle")}
      </h2>
      <p className="text-muted-foreground text-xs">{t("searchesHint")}</p>
      <ul className="grid gap-2" data-testid="guest-searches">
        {items.map((item) => (
          <li
            key={`${item.kind}:${item.params}`}
            className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
          >
            <Link
              href={`${KIND_PATH[item.kind]}?${item.params}`}
              className="hover:text-primary flex min-w-0 items-center gap-2"
            >
              <Search className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{item.title}</span>
            </Link>
            <button
              type="button"
              onClick={() => remove(item)}
              aria-label={t("removeSearch", { title: item.title })}
              className="text-muted-foreground hover:text-foreground grid size-8 shrink-0 place-items-center rounded-md"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
