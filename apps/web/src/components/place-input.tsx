"use client";

import type { Place } from "@tickets/shared";
import { MapPin, Plane } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const IATA = /^[A-Za-z]{3}$/;
const DEBOUNCE_MS = 150;

/** `picked` — місце вибрано зі списку (у полі назва), а не введено вручну. */
export type PlaceValue = { code: string; label: string; picked: boolean };

export function placeValue(code: string | undefined): PlaceValue {
  return { code: code ?? "", label: code ?? "", picked: false };
}

/** Підпис місця у полі: «Варшава, Фредерік Шопен», «Лондон — усі аеропорти». */
export function placeLabel(place: Place, allAirports: string): string {
  if (place.kind === "city") return `${place.city_name} — ${allAirports}`;
  return place.name === place.city_name ? place.city_name : `${place.city_name}, ${place.name}`;
}

function pickedValue(place: Place, allAirports: string): PlaceValue {
  return { code: place.code, label: placeLabel(place, allAirports), picked: true };
}

/** Код з того, що ввели вручну: лише якщо це рівно 3 латинські літери. */
export function codeFromText(text: string): string {
  const trimmed = text.trim();
  return IATA.test(trimmed) ? trimmed.toUpperCase() : "";
}

type Props = {
  id: string;
  name: string;
  value: PlaceValue;
  onChange: (value: PlaceValue) => void;
  placeholder: string;
  /** Підміна мережі в тестах. */
  loadPlaces?: (q: string, signal: AbortSignal) => Promise<Place[]>;
};

async function fetchPlaces(q: string, signal: AbortSignal): Promise<Place[]> {
  const response = await fetch(`/api/places?${new URLSearchParams({ q })}`, { signal });
  return response.ok ? ((await response.json()) as Place[]) : [];
}

/**
 * Поле міста/аеропорту з підказками (ARIA combobox). Форма отримує IATA-код
 * з прихованого поля; без JS видиме поле саме має `name` і приймає код вручну.
 */
export function PlaceInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  loadPlaces = fetchPlaces,
}: Props) {
  const t = useTranslations("search");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  // Код з URL (WAW) → зрозуміла назва в полі, якщо довідник його знає.
  useEffect(() => {
    const { code, picked } = latest.current.value;
    if (!code || picked) return;
    const controller = new AbortController();
    loadPlaces(code, controller.signal)
      .then((found) => {
        const place = found.find((p) => p.code === code);
        // Поки чекали, користувач міг почати вводити — тоді його текст не чіпаємо.
        if (place && latest.current.value.label === code) {
          latest.current.onChange(pickedValue(place, t("allAirports")));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [loadPlaces, t]);

  // Підказки після паузи у введенні; застарілий запит скасовуємо.
  const text = value.label;
  const selected = value.picked;
  const wanted = open && !selected && text.trim().length >= 2;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      loadPlaces(text.trim(), controller.signal)
        .then((found) => {
          setPlaces(found);
          setActive(found.length ? 0 : -1);
        })
        .catch(() => {}); // скасовано або мережа — просто без підказок
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, wanted, loadPlaces]);
  // Старі підказки не показуємо, коли вони вже не потрібні (вибрано, закрито, короткий текст).
  const shown = wanted ? places : [];
  const expanded = shown.length > 0;

  // Без вибору зі списку форма не відправиться, якщо введене — не код.
  useEffect(() => {
    inputRef.current?.setCustomValidity(value.code || !text ? "" : t("pickPlace"));
  }, [value.code, text, t]);

  function choose(place: Place) {
    onChange(pickedValue(place, t("allAirports")));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (shown.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (event.key === "Enter" && active >= 0 && active < shown.length) {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  // Аеропорти міста, для якого є рядок «усі аеропорти», показуємо з відступом під ним.
  const inCityGroup = new Set(shown.flatMap((p) => (p.kind === "city" ? p.airports : [])));
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        // До гідратації поле саме несе код (форма працює без JS).
        name={hydrated ? undefined : name}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        required
        placeholder={placeholder}
        title={t("iataHint")}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setOpen(true);
          const label = e.target.value;
          onChange({ code: codeFromText(label), label, picked: false });
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="pr-14"
      />
      {value.code && (
        <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs">
          {value.code}
        </span>
      )}
      {hydrated && <input type="hidden" name={name} value={value.code} />}
      <ul
        id={listId}
        role="listbox"
        aria-label={t("suggestions")}
        hidden={!expanded}
        className="bg-popover text-popover-foreground absolute z-20 mt-1 max-h-80 w-full min-w-64 overflow-auto rounded-md border p-1 shadow-md"
      >
        {shown.map((place, index) => (
          <li
            key={place.code}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            // mousedown, а не click: інакше blur поля закриє список раніше.
            onMouseDown={(e) => {
              e.preventDefault();
              choose(place);
            }}
            onMouseEnter={() => setActive(index)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
              index === active && "bg-accent text-accent-foreground",
              place.kind === "airport" && inCityGroup.has(place.code) && "pl-6",
            )}
          >
            {place.kind === "city" ? (
              <MapPin className="text-muted-foreground size-4 shrink-0" aria-hidden />
            ) : (
              <Plane className="text-muted-foreground size-4 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">
              {placeLabel(place, t("allAirports"))}
              <span className="text-muted-foreground"> · {place.country_name}</span>
            </span>
            <span className="text-muted-foreground font-mono text-xs">{place.code}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
