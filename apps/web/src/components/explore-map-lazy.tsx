"use client";

import dynamic from "next/dynamic";

/** Карта напрямків — окремим чанком лише в режимі «Карта» (як карта житла, ADR 0035). */
export const ExploreMapLazy = dynamic(
  () => import("@/components/explore-map").then((m) => m.ExploreMap),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden
        className="shimmer h-[60vh] min-h-80 rounded-xl border lg:h-[calc(100dvh-10rem)]"
      />
    ),
  },
);
