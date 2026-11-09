"use client";

import dynamic from "next/dynamic";

/**
 * Карта житла — окремим чанком лише в режимі «Карта» (модуль 17.5): MapLibre (≈ 290 КБ gzip)
 * і його CSS (≈ 70 КБ, блокує рендер) не вантажаться зі списком. Поки чанк іде — заглушка
 * того самого розміру, без зсуву сторінки.
 */
export const StayMapLazy = dynamic(() => import("@/components/stay-map").then((m) => m.StayMap), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden
      className="shimmer h-[60vh] min-h-80 rounded-xl border lg:h-[calc(100dvh-8rem)]"
    />
  ),
});
