"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { LngLatBounds, Map as MapLibreMap, Marker } from "maplibre-gl";
import { ArrowRight, Search, Star, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FOCUS_EVENT } from "@/lib/map-events";
import { bboxParam } from "@/lib/stay-params";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

/** Безкоштовні векторні тайли OpenFreeMap (дані OpenStreetMap), без ключа — ADR 0019. */
export const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
/** Копія воркера з node_modules (scripts/copy-maplibre-worker.mjs) — збирач його не підхоплює. */
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

export type MapStay = {
  key: string;
  anchor: string;
  name: string;
  lat: number;
  lon: number;
  price: number;
  currency: string;
  rating: number | null;
};

/**
 * Карта житла (модуль 6): маркери з цінами лише для об'єктів з координатами (вигаданих не
 * ставимо), вибір маркера — коротка картка й «Детальніше», рух і масштаб — стандартні жести,
 * «Шукати в цій області» — фільтр за видимою областю (без нових запитів до джерел).
 */
export function StayMap({
  stays,
  withoutCoordinates,
  baseParams,
  listHref,
}: {
  stays: MapStay[];
  /** Скільки об'єктів видачі без координат — їх на карті немає. */
  withoutCoordinates: number;
  /** Поточний пошук без `bbox` (рядок URL) — для «Шукати в цій області». */
  baseParams: string;
  /** Посилання на список (для «Детальніше» на телефоні, де список схований). */
  listHref: string;
}) {
  const t = useTranslations("stayMap");
  const format = useFormatter();
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const [selected, setSelected] = useState<string | null>(null);
  const [moved, setMoved] = useState<LngLatBounds | null>(null);
  const [failed, setFailed] = useState(false);

  const money = (s: MapStay) =>
    format.number(s.price, {
      style: "currency",
      currency: s.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(s.price),
    });

  useEffect(() => {
    let cancelled = false;
    let resize: ResizeObserver | null = null;
    const created = markers.current;
    import("maplibre-gl")
      .then((maplibregl) => {
        if (cancelled || !container.current) return;
        maplibregl.setWorkerUrl(WORKER_URL);
        const instance = new maplibregl.Map({
          container: container.current,
          style: MAP_STYLE,
          center: [stays[0]?.lon ?? 0, stays[0]?.lat ?? 0],
          zoom: 12,
        });
        instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.current = instance;
        if (stays.length > 1) {
          const bounds = new maplibregl.LngLatBounds();
          for (const s of stays) bounds.extend([s.lon, s.lat]);
          instance.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
        }
        for (const s of stays) {
          const el = document.createElement("button");
          el.type = "button";
          markerStyle(el, false);
          el.textContent = money(s);
          el.setAttribute("aria-label", t("marker", { name: s.name, price: money(s) }));
          el.dataset.testid = "stay-marker";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            setSelected(s.key);
          });
          created.set(
            s.key,
            new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(instance),
          );
        }
        // Кнопка «Шукати в цій області» — лише після руху, який зробила людина.
        instance.on("moveend", (e) => {
          if ((e as { originalEvent?: unknown }).originalEvent) setMoved(instance.getBounds());
        });
        instance.on("click", () => setSelected(null));
        // Контейнер міг не мати висоти в момент створення (розкладка ще будувалась):
        // підлаштовуємо полотно під кожну зміну розміру.
        resize = new ResizeObserver(() => instance.resize());
        resize.observe(container.current);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      resize?.disconnect();
      for (const m of created.values()) m.remove();
      created.clear();
      map.current?.remove();
      map.current = null;
    };
    // Карта будується раз на набір об'єктів (новий пошук — новий компонент через key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Підсвітка вибраного маркера.
  useEffect(() => {
    for (const [key, marker] of markers.current) {
      markerStyle(marker.getElement(), key === selected);
    }
  }, [selected]);

  // Синхронізація список → карта: «На карті» в картці.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      const stay = stays.find((s) => s.key === key);
      if (!stay) return;
      setSelected(key);
      map.current?.flyTo({
        center: [stay.lon, stay.lat],
        zoom: Math.max(map.current.getZoom(), 14),
      });
      container.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, [stays]);

  const current = stays.find((s) => s.key === selected) ?? null;

  function searchHere() {
    if (!moved) return;
    const params = new URLSearchParams(baseParams);
    params.set(
      "bbox",
      bboxParam({
        south: moved.getSouth(),
        west: moved.getWest(),
        north: moved.getNorth(),
        east: moved.getEast(),
      }),
    );
    params.set("view", "map");
    router.push(`/stays?${params}`, { scroll: false });
  }

  return (
    <section className="grid gap-2" aria-label={t("title")} data-testid="stay-map">
      <div className="relative h-[60vh] min-h-80 overflow-hidden rounded-xl border lg:h-[calc(100dvh-8rem)]">
        {/* Не absolute: maplibre ставить контейнеру position: relative (.maplibregl-map). */}
        <div ref={container} className="h-full w-full" />
        {failed && (
          <p className="bg-card absolute inset-0 grid place-items-center p-4 text-sm">
            {t("failed")}
          </p>
        )}
        {moved && (
          <Button
            type="button"
            size="sm"
            className="absolute top-3 left-1/2 z-10 -translate-x-1/2 shadow-md"
            onClick={searchHere}
          >
            <Search className="size-3.5" aria-hidden />
            {t("searchHere")}
          </Button>
        )}
        {current && (
          <div
            className="bg-card absolute inset-x-3 bottom-3 z-10 grid gap-1 rounded-lg border p-3 shadow-lg sm:right-auto sm:w-72"
            data-testid="stay-map-card"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">{current.name}</p>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("close")}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <p className="flex items-center gap-2 text-sm">
              <span className="font-bold tabular-nums">{money(current)}</span>
              <span className="text-muted-foreground text-xs">{t("perNight")}</span>
              {current.rating != null && (
                <span className="text-muted-foreground flex items-center gap-0.5 text-xs">
                  <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
                  {format.number(current.rating, { maximumFractionDigits: 1 })}
                </span>
              )}
            </p>
            <a
              href={`${listHref}#${current.anchor}`}
              className={cn(
                "text-primary flex items-center gap-1 text-sm font-medium hover:underline",
              )}
            >
              {t("details")}
              <ArrowRight className="size-3.5" aria-hidden />
            </a>
          </div>
        )}
      </div>
      {withoutCoordinates > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("withoutCoordinates", { count: withoutCoordinates })}
        </p>
      )}
    </section>
  );
}

/** Вигляд маркера-«пігулки» з ціною (інлайн, через змінні теми): вибраний — синій і над іншими. */
function markerStyle(el: HTMLElement, selected: boolean) {
  Object.assign(el.style, {
    cursor: "pointer",
    borderRadius: "9999px",
    border: `1px solid ${selected ? "var(--primary)" : "var(--border)"}`,
    background: selected ? "var(--primary)" : "var(--card)",
    color: selected ? "var(--primary-foreground)" : "var(--foreground)",
    padding: "2px 8px",
    fontSize: "12px",
    fontWeight: "600",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    boxShadow: "0 1px 3px rgb(0 0 0 / 0.25)",
    zIndex: selected ? "2" : "1",
  });
}
