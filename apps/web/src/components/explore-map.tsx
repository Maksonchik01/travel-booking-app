"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { ArrowRight, Luggage, Plane, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { MAP_STYLE, markerStyle, WORKER_URL } from "@/components/stay-map";
import { fractionDigits } from "@/lib/money";

export type MapDestination = {
  code: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  price: number;
  currency: string;
  dates: string;
  flightsHref: string;
  tripHref: string;
};

/**
 * Карта напрямків Explore (ADR 0045): маркер-ціна на кожне місто з координатами довідника, вибір —
 * коротка картка з датами й переходами до рейсів чи поїздки. Без нових запитів до джерел.
 */
export function ExploreMap({
  destinations,
  listHref,
}: {
  destinations: MapDestination[];
  /** Список того самого пошуку — «До картки». */
  listHref: string;
}) {
  const t = useTranslations("explore.map");
  const format = useFormatter();
  const container = useRef<HTMLDivElement>(null);
  const markers = useRef(new Map<string, Marker>());
  const map = useRef<MapLibreMap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const money = (d: MapDestination) =>
    format.number(d.price, {
      style: "currency",
      currency: d.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(d.price),
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
          center: [destinations[0]?.lon ?? 10, destinations[0]?.lat ?? 48],
          zoom: 3,
        });
        instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.current = instance;
        if (destinations.length > 1) {
          const bounds = new maplibregl.LngLatBounds();
          for (const d of destinations) bounds.extend([d.lon, d.lat]);
          instance.fitBounds(bounds, { padding: 48, maxZoom: 6, duration: 0 });
        }
        for (const d of destinations) {
          const el = document.createElement("button");
          el.type = "button";
          markerStyle(el, false);
          el.textContent = money(d);
          el.setAttribute("aria-label", t("marker", { city: d.city, price: money(d) }));
          el.dataset.testid = "explore-marker";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            setSelected(d.code);
          });
          created.set(
            d.code,
            new maplibregl.Marker({ element: el }).setLngLat([d.lon, d.lat]).addTo(instance),
          );
        }
        instance.on("click", () => setSelected(null));
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
    // Карта будується раз на набір напрямків (новий пошук — новий компонент через key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const [code, marker] of markers.current)
      markerStyle(marker.getElement(), code === selected);
  }, [selected]);

  const current = destinations.find((d) => d.code === selected) ?? null;

  return (
    <section className="grid gap-2" aria-label={t("title")} data-testid="explore-map">
      <div className="relative h-[60vh] min-h-80 overflow-hidden rounded-xl border lg:h-[calc(100dvh-10rem)]">
        <div ref={container} className="h-full w-full" />
        {failed && (
          <p className="bg-card absolute inset-0 grid place-items-center p-4 text-sm">
            {t("failed")}
          </p>
        )}
        {current && (
          <div
            className="bg-card absolute inset-x-3 bottom-3 z-10 grid gap-2 rounded-lg border p-3 shadow-lg sm:right-auto sm:w-80"
            data-testid="explore-map-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{current.city}</p>
                <p className="text-muted-foreground text-xs">
                  {current.country} · {current.dates}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("close")}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <p className="text-lg font-bold tabular-nums">{money(current)}</p>
            <div className="flex flex-wrap gap-3 text-sm font-medium">
              <Link
                href={current.flightsHref}
                className="text-primary flex items-center gap-1 hover:underline"
              >
                <Plane className="size-3.5" aria-hidden />
                {t("toFlights")}
              </Link>
              <Link
                href={current.tripHref}
                className="text-primary flex items-center gap-1 hover:underline"
              >
                <Luggage className="size-3.5" aria-hidden />
                {t("toTrip")}
              </Link>
              <a
                href={`${listHref}#dest-${current.code}`}
                className="text-muted-foreground hover:text-primary flex items-center gap-1"
              >
                {t("toCard")}
                <ArrowRight className="size-3.5" aria-hidden />
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
