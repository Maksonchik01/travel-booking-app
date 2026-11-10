"use client";

import type { GeocodeResult, GeoPlace } from "@tickets/shared";
import { Loader2, MapPin, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { MAX_NEAR_NAME } from "@/lib/stay-params";
import { FIELD_CLASS } from "@/lib/styles";

type Status = "idle" | "loading" | "empty" | "error";

/**
 * «Біля місця» у фільтрах житла (етап 5, ADR 0049): адреса чи визначна точка в місті пошуку —
 * OpenStreetMap Nominatim через наш API, лише кнопкою «Знайти» (політика Nominatim). Вибране —
 * приховані `near` (координати) і `nearname` (підпис) у формі фільтрів; радіус — поле поруч.
 * Поле вводу не запускає автозастосування форми (зміни не спливають до неї).
 */
export function NearPlace({
  city,
  near,
  name,
  autoApply,
}: {
  city: string;
  near: { lat: number; lon: number } | null | undefined;
  name: string | undefined;
  /** Десктоп: форма фільтрів застосовується одразу; у вікні на телефоні — кнопкою. */
  autoApply: boolean;
}) {
  const t = useTranslations("nearPlace");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [places, setPlaces] = useState<GeoPlace[]>([]);
  const [picked, setPicked] = useState(
    near ? { lat: near.lat, lon: near.lon, name: name ?? t("chosenPoint") } : null,
  );
  const root = useRef<HTMLDivElement>(null);

  function submitForm() {
    // Після оновлення прихованих полів — застосувати фільтри (як будь-яка зміна у формі).
    if (!autoApply) return;
    setTimeout(() => root.current?.closest("form")?.requestSubmit(), 0);
  }

  async function search() {
    const q = text.trim();
    if (q.length < 2) return;
    setStatus("loading");
    try {
      const response = await fetchWithTimeout(
        `/api/places/geocode?${new URLSearchParams({ q, city })}`,
      );
      const data = (await response.json()) as GeocodeResult;
      if (!response.ok || data.status !== "ok") {
        setPlaces([]);
        setStatus("error");
        return;
      }
      setPlaces(data.places);
      setStatus(data.places.length ? "idle" : "empty");
    } catch {
      setPlaces([]);
      setStatus("error");
    }
  }

  function choose(place: GeoPlace) {
    setPicked({ lat: place.lat, lon: place.lon, name: place.name.slice(0, MAX_NEAR_NAME) });
    setPlaces([]);
    setText("");
    submitForm();
  }

  function clear() {
    setPicked(null);
    submitForm();
  }

  return (
    <div ref={root} className="grid gap-2" data-testid="near-place">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {t("title")}
      </span>
      {picked ? (
        <div className="bg-accent text-accent-foreground flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate" data-testid="near-place-chosen">
              {picked.name}
            </span>
          </span>
          <button
            type="button"
            onClick={clear}
            aria-label={t("clear", { name: picked.name })}
            className="hover:bg-background/60 grid size-5 shrink-0 place-items-center rounded-full"
          >
            <X className="size-3" aria-hidden />
          </button>
          <input type="hidden" name="near" value={`${picked.lat},${picked.lon}`} />
          <input type="hidden" name="nearname" value={picked.name} />
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Input
            aria-label={t("label")}
            placeholder={t("placeholder")}
            value={text}
            maxLength={120}
            // Зміни поля не спливають до форми фільтрів — вона не застосовується на кожну літеру.
            onChange={(e) => {
              e.stopPropagation();
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
            className={`${FIELD_CLASS} h-9 text-sm`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => void search()}
            disabled={text.trim().length < 2 || status === "loading"}
            aria-label={t("search")}
            data-testid="near-place-search"
          >
            {status === "loading" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Search className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      )}
      {places.length > 0 && (
        <ul className="grid gap-1" aria-label={t("results")}>
          {places.map((place) => (
            <li key={`${place.lat},${place.lon}`}>
              <button
                type="button"
                onClick={() => choose(place)}
                className="hover:bg-accent grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left text-xs"
                data-testid="near-place-option"
              >
                <span className="font-medium">{place.name}</span>
                <span className="text-muted-foreground line-clamp-1">{place.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === "empty" && <p className="text-muted-foreground text-xs">{t("empty")}</p>}
      {status === "error" && (
        <p className="text-muted-foreground text-xs" role="status">
          {t("error")}
        </p>
      )}
      <p className="text-muted-foreground text-[11px]">{t("hint")}</p>
    </div>
  );
}
