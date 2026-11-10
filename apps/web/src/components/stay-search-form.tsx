"use client";

import type { StayProfile } from "@tickets/shared";
import { Building2, Loader2, Search } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { ParamsToggle } from "@/components/params-toggle";
import { PlaceInput, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CommonSearch } from "@/lib/search-modes";
import { addDays, CURRENCIES } from "@/lib/search-params";
import {
  AMENITIES,
  MAX_DISTANCE_OPTIONS,
  MAX_NIGHTS,
  MAX_ROOMS,
  MIN_RATING_OPTIONS,
  nightsBetween,
  STAY_KINDS,
  STAY_PROFILES,
  type StayState,
} from "@/lib/stay-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

/** Пошук житла: місто, дати, гості, що важливіше. Звичайна GET-форма — працює й без JS. */
export type StayFormPrefs = {
  filters: [string, string][];
  profile?: StayProfile | null;
  /** Валюта профілю (модуль 18.2) — для нового пошуку. */
  currency?: string | null;
};

export function StaySearchForm({
  initial,
  prefs = null,
  carried = null,
}: {
  initial: StayState | null;
  /** Перенесене з іншого режиму (модуль 12.2), коли для пошуку ще чогось бракує. */
  carried?: CommonSearch | null;
  /** Налаштування пошуку житла з профілю (модуль 10b): фільтри й пріоритет. */
  prefs?: StayFormPrefs | null;
}) {
  const t = useTranslations("stays");
  const q = initial?.query;
  const c = q ? null : carried;
  const [city, setCity] = useState(() => placeValue(q?.city ?? c?.to));
  const [checkIn, setCheckIn] = useState(q?.check_in ?? c?.depart ?? "");
  const [checkOut, setCheckOut] = useState(q?.check_out ?? c?.return ?? "");
  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;
  const [children, setChildren] = useState(q?.guests?.children ?? c?.children ?? 0);

  return (
    <Form action="/stays" className="grid gap-4" data-search-form>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label={t("city")} htmlFor="city">
          <PlaceInput
            id="city"
            name="city"
            value={city}
            onChange={setCity}
            placeholder={t("cityPlaceholder")}
            icon={<Building2 />}
            kind="city"
          />
        </Field>
        <Field label={t("checkIn")} htmlFor="in">
          <Input
            id="in"
            name="in"
            type="date"
            required
            className={FIELD_CLASS}
            value={checkIn}
            onChange={(e) => {
              setCheckIn(e.target.value);
              // Виїзд не раніше заїзду: зручно, коли дату виїзду ще не обрали.
              if (e.target.value && (!checkOut || checkOut <= e.target.value)) {
                setCheckOut(addDays(e.target.value, 1));
              }
            }}
          />
        </Field>
        <Field
          label={t("checkOut")}
          hint={nights > 0 ? t("nights", { count: nights }) : undefined}
          htmlFor="out"
        >
          <Input
            id="out"
            name="out"
            type="date"
            required
            className={FIELD_CLASS}
            min={checkIn ? addDays(checkIn, 1) : undefined}
            max={checkIn ? addDays(checkIn, MAX_NIGHTS) : undefined}
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t("adults")} htmlFor="adults">
          <select
            id="adults"
            name="adults"
            defaultValue={q?.guests?.adults ?? c?.adults ?? 2}
            className={SELECT_CLASS}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("children")} htmlFor="children">
          <select
            id="children"
            name="children"
            value={children}
            onChange={(e) => setChildren(Number(e.target.value))}
            className={SELECT_CLASS}
          >
            {Array.from({ length: 9 }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("currency")} htmlFor="stay-cur">
          <select
            id="stay-cur"
            name="cur"
            defaultValue={q?.currency ?? prefs?.currency ?? "EUR"}
            className={SELECT_CLASS}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("rooms")} htmlFor="rooms">
          <select
            id="rooms"
            name="rooms"
            defaultValue={q?.guests?.rooms ?? 1}
            className={SELECT_CLASS}
          >
            {Array.from({ length: MAX_ROOMS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {children > 0 && (
        <fieldset className="grid gap-2" data-testid="children-ages">
          <legend className="text-muted-foreground mb-1.5 text-xs font-medium">
            {t("childrenAges")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: children }, (_, i) => (
              <select
                key={i}
                name="ages"
                aria-label={t("childAge", { n: i + 1 })}
                defaultValue={q?.guests?.children_ages?.[i] ?? ""}
                className={cn(SELECT_CLASS, "w-28")}
                required
              >
                <option value="" disabled>
                  {t("childAge", { n: i + 1 })}
                </option>
                {Array.from({ length: 18 }, (_, age) => (
                  <option key={age} value={age}>
                    {t("age", { count: age })}
                  </option>
                ))}
              </select>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t("childrenAgesHint")}</p>
        </fieldset>
      )}

      <StayMoreOptions filters={q?.filters} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <fieldset className="flex items-center gap-2 text-sm">
          <legend className="text-muted-foreground float-left mr-2 text-xs font-medium">
            {t("priority")}
          </legend>
          <div className="bg-muted inline-flex rounded-lg p-1">
            {STAY_PROFILES.map((profile) => (
              <label
                key={profile}
                className="text-muted-foreground hover:text-foreground has-[:checked]:bg-card has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 transition-all has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
              >
                <input
                  type="radio"
                  name="prio"
                  value={profile}
                  defaultChecked={
                    (q?.profile ?? (q ? null : prefs?.profile) ?? "balanced") === profile
                  }
                  className="sr-only"
                />
                {t(`priorities.${profile}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <SubmitButton idle={t("submit")} pending={t("searching")} />
      </div>
      {prefs && (
        <ParamsToggle
          entries={prefs.filters}
          label={t("usePrefs", { count: prefs.filters.length })}
          testId="stay-prefs-toggle"
        />
      )}
    </Form>
  );
}

function SubmitButton({ idle, pending }: { idle: string; pending: string }) {
  const status = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      className="shadow-primary/30 hover:shadow-primary/40 h-11 min-w-40 rounded-lg px-6 text-base shadow-lg transition-all hover:-translate-y-px hover:shadow-xl active:translate-y-0"
      disabled={status.pending}
    >
      {status.pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Search className="size-4" aria-hidden />
      )}
      {status.pending ? pending : idle}
    </Button>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-medium">
        {label}
        {hint && <span className="text-primary font-normal">· {hint}</span>}
      </Label>
      {children}
    </div>
  );
}

/**
 * «Більше налаштувань» (етап 5): рейтинг, тип, розташування, зручності, скасування — ті самі
 * параметри URL, що й фільтри видачі (`rating`, `kind`, `dist`, `am`, `cancel`). Застосовуються
 * після джерела: окремих запитів не роблять. Розкрито, якщо щось уже задано.
 */
function StayMoreOptions({ filters }: { filters: StayState["query"]["filters"] | undefined }) {
  const t = useTranslations("stayFilters");
  const tForm = useTranslations("stays");
  const tKind = useTranslations("stayCard.kind");
  const tAmenity = useTranslations("stayCard.amenity");
  const open = Boolean(
    filters?.min_rating ||
    filters?.kinds?.length ||
    filters?.max_distance_center_km ||
    filters?.amenities?.length ||
    filters?.free_cancellation,
  );
  const chip =
    "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:focus-visible]:ring-ring/40 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium has-[:focus-visible]:ring-3";
  return (
    <details className="grid gap-3 rounded-lg border px-3 py-2" open={open} data-testid="stay-more">
      <summary className="text-muted-foreground hover:text-primary cursor-pointer text-sm font-medium select-none">
        {tForm("more")}
      </summary>
      <div className="grid gap-4 pt-3 pb-1">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="grid gap-1.5">
            <span className="text-muted-foreground text-xs font-medium">{t("rating")}</span>
            <select name="rating" defaultValue={filters?.min_rating ?? ""} className={SELECT_CLASS}>
              <option value="">{t("any")}</option>
              {MIN_RATING_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}+
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5">
            <span className="text-muted-foreground text-xs font-medium">{t("distance")}</span>
            <select
              name="dist"
              defaultValue={filters?.max_distance_center_km ?? ""}
              className={SELECT_CLASS}
            >
              <option value="">{t("any")}</option>
              {MAX_DISTANCE_OPTIONS.map((km) => (
                <option key={km} value={km}>
                  {t("upToKm", { km })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm">
            <input
              type="checkbox"
              name="cancel"
              value="1"
              defaultChecked={filters?.free_cancellation ?? false}
              className="size-4"
            />
            {t("freeCancellation")}
          </label>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">{t("kind")}</legend>
          <div className="flex flex-wrap gap-2">
            {STAY_KINDS.map((kind) => (
              <label key={kind} className={chip}>
                <input
                  type="checkbox"
                  name="kind"
                  value={kind}
                  defaultChecked={filters?.kinds?.includes(kind) ?? false}
                  className="sr-only"
                />
                {tKind(kind)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">
            {t("amenities")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {AMENITIES.map((amenity) => (
              <label key={amenity} className={chip}>
                <input
                  type="checkbox"
                  name="am"
                  value={amenity}
                  defaultChecked={filters?.amenities?.includes(amenity) ?? false}
                  className="sr-only"
                />
                {tAmenity(amenity)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-muted-foreground text-[11px]">{tForm("moreHint")}</p>
      </div>
    </details>
  );
}
