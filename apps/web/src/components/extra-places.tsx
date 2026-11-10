"use client";

import type { Place } from "@tickets/shared";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { FETCHERS, PlaceInput, type PlaceValue, placeLabel } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { MAX_PLACES } from "@/lib/search-params";

/**
 * Додаткові аеропорти вильоту чи прибуття (модуль 2): «Амстердам, Роттердам, Ейндговен».
 * Кожен — «чип» з кнопкою «прибрати» й прихованим полем з тим самим `name`, що й основне
 * (`from=AMS&from=RTM`). Додати — те саме поле з підказками: місто («усі аеропорти»),
 * назва чи IATA-код. Сусідні аеропорти (позначка «у радіусі») працюють разом з цими.
 */
export function ExtraPlaces({
  id,
  name,
  values,
  onChange,
  exclude,
  loadPlaces = FETCHERS.any,
}: {
  id: string;
  name: string;
  values: PlaceValue[];
  onChange: (values: PlaceValue[]) => void;
  /** Коди, які вже обрані (основне поле, інший бік маршруту) — їх не додаємо вдруге. */
  exclude: string[];
  loadPlaces?: (q: string, signal: AbortSignal) => Promise<Place[]>;
}) {
  const t = useTranslations("search");
  const [adding, setAdding] = useState<PlaceValue | null>(null);
  const latest = useRef({ values, onChange });
  useEffect(() => {
    latest.current = { values, onChange };
  });

  // Коди з URL → зрозумілі назви (як в основному полі).
  const unnamed = values
    .filter((v) => !v.picked)
    .map((v) => v.code)
    .join(",");
  useEffect(() => {
    if (!unnamed) return;
    const controller = new AbortController();
    for (const code of unnamed.split(",")) {
      loadPlaces(code, controller.signal)
        .then((found) => {
          const place = found.find((p) => p.code === code);
          if (!place) return;
          const label = placeLabel(place, t("allAirports"));
          const { values: current, onChange: update } = latest.current;
          update(current.map((v) => (v.code === code ? { code, label, picked: true } : v)));
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [unnamed, loadPlaces, t]);

  const room = values.length < MAX_PLACES - 1;
  const taken = new Set([...exclude, ...values.map((v) => v.code)]);

  function add(value: PlaceValue) {
    if (!value.code || taken.has(value.code)) return;
    onChange([...values, value]);
    setAdding(null);
  }

  return (
    <div className="grid gap-1.5" data-testid={`${id}-extra`}>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("extraAirports")}>
          {values.map((value) => (
            <li
              key={value.code}
              className="bg-accent text-accent-foreground flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs font-medium"
              data-testid="extra-place"
            >
              <span className="max-w-48 truncate">{value.label || value.code}</span>
              <span className="text-muted-foreground font-mono">{value.code}</span>
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v.code !== value.code))}
                aria-label={t("removeAirport", { name: value.label || value.code })}
                className="hover:bg-background/60 grid size-5 place-items-center rounded-full"
              >
                <X className="size-3" aria-hidden />
              </button>
              <input type="hidden" name={name} value={value.code} />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <PlaceInput
              id={`${id}-add`}
              name=""
              required={false}
              value={adding}
              onChange={(next) => (next.picked ? add(next) : setAdding(next))}
              placeholder={t("extraPlaceholder")}
              loadPlaces={loadPlaces}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!adding.code || taken.has(adding.code)}
            onClick={() => add(adding)}
          >
            {t("addAirportConfirm")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setAdding(null)}
            aria-label={t("cancelAddAirport")}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ) : (
        room && (
          <button
            type="button"
            onClick={() => setAdding({ code: "", label: "", picked: false })}
            className="text-primary flex w-fit items-center gap-1 text-xs font-medium hover:underline"
            data-testid={`${id}-add-airport`}
          >
            <Plus className="size-3.5" aria-hidden />
            {t("addAirport")}
          </button>
        )
      )}
    </div>
  );
}
