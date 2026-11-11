"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { resultsInUrl } from "@/lib/search-shell";

/**
 * Заглушки обох станів сторінки пошуку (`lib/search-shell.ts`): CSS показує одну за атрибутом
 * `data-search` на `<html>`. Для Suspense-fallback статичної оболонки.
 */
export function ShellChoice({
  start,
  results,
}: {
  start: React.ReactNode;
  results: React.ReactNode;
}) {
  return (
    <>
      <div data-shell="start">{start}</div>
      <div data-shell="results">{results}</div>
    </>
  );
}

/** Висота згорнутої форми (вкладки режимів + рядок «що шукаємо»): телефон 176, ≥ sm 108 px. */
export function CollapsedSearchSkeleton() {
  return <div className="shimmer h-[176px] rounded-lg sm:h-[108px]" aria-hidden />;
}

/** Переходи без перезавантаження: атрибут — за поточною адресою. */
export function SearchShellSync() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    const root = document.documentElement;
    if (resultsInUrl(new URLSearchParams(search.toString()))) root.dataset.search = "results";
    else delete root.dataset.search;
  }, [pathname, search]);
  return null;
}
