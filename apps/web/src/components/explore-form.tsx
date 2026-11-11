"use client";

import type { ExploreQuery } from "@tickets/shared";
import { Globe2, Loader2, MapPin, PlaneTakeoff, Search, Shuffle, Waves } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { EntryNotice } from "@/components/entry-notice";
import { PlaceInput, type PlaceValue, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CATEGORIES,
  DATE_TOLERANCES,
  EXPLORE_PATH,
  NIGHT_PRESETS,
  REGIONS,
  dateWindow,
  windowOf,
} from "@/lib/explore-params";
import { CURRENCIES } from "@/lib/search-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

/** «Куди»: будь-куди (""), регіон, «море й острови» (категорія) або країна з URL (ISO2). */
type Destination = string;
const SEA = "sea";

const CHIP =
  "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:focus-visible]:ring-ring/40 cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium transition-colors hover:border-primary/60 has-[:focus-visible]:ring-3";

/**
 * Explore (ADR 0045, переробка ADR 0054): для того, хто ще не знає, куди. Спершу — «куди
 * приблизно» (першим «Не знаю — будь-куди», далі частини світу й «море й острови»), потім
 * звідки, бажана дата ± похибка й скільки ночей. Решта (бюджет, люди, валюта, житло, категорії)
 * — у «Більше налаштувань». Дата ± похибка → приховані `depart`/`until`: запит той самий.
 */
export function ExploreForm({
  initial,
  countryName,
  today,
}: {
  initial: Partial<ExploreQuery> | null;
  /** Назва країни з URL (`to=ES`) мовою сторінки — окремий варіант «куди». */
  countryName?: string;
  /** Сьогодні (YYYY-MM-DD). */
  today: string;
}) {
  const t = useTranslations("explore.form");
  const tCat = useTranslations("explore.category");
  const tRegion = useTranslations("explore.region");
  const tSearch = useTranslations("search");
  const start = useMemo(() => windowOf(initial ?? {}, today), [initial, today]);
  const initialSea = !initial?.region && !initial?.country && initial?.categories?.includes("sea");
  const [destination, setDestination] = useState<Destination>(
    initial?.region ?? initial?.country ?? (initialSea ? SEA : ""),
  );
  const [from, setFrom] = useState<PlaceValue>(() => placeValue(initial?.origins?.[0]));
  const [center, setCenter] = useState(start.center);
  const [tolerance, setTolerance] = useState(start.tolerance);
  const [nights, setNights] = useState(`${start.nights[0]}-${start.nights[1]}`);
  const [currency, setCurrency] = useState<string>(initial?.currency ?? "EUR");
  const [nmin, nmax] = nights.split("-");
  const range = dateWindow(center || today, tolerance, today);
  const nightOptions = useMemo(() => {
    const options = NIGHT_PRESETS.map(([a, b]) => `${a}-${b}`);
    return options.includes(nights) ? options : [...options, nights];
  }, [nights]);
  const toleranceOptions = useMemo(
    () =>
      (DATE_TOLERANCES as readonly number[]).includes(tolerance)
        ? DATE_TOLERANCES
        : [...DATE_TOLERANCES, tolerance],
    [tolerance],
  );
  // Категорії з «Більше налаштувань»; «море» з вибору «куди» додається окремо.
  const extraCategories = (initial?.categories ?? []).filter((c) => !(initialSea && c === "sea"));
  const advanced = Boolean(
    initial?.direct_only ||
    extraCategories.length ||
    initial?.budget ||
    (initial?.adults ?? 1) > 1 ||
    initial?.weekends ||
    initial?.mode === "trip",
  );

  const places: { value: Destination; label: string; icon?: React.ReactNode }[] = [
    { value: "", label: t("anywhere"), icon: <Shuffle className="size-4" aria-hidden /> },
    ...REGIONS.map((r) => ({ value: r, label: tRegion(r) })),
    { value: SEA, label: t("seaIslands"), icon: <Waves className="size-4" aria-hidden /> },
    ...(initial?.country
      ? [
          {
            value: initial.country,
            label: countryName ?? initial.country,
            icon: <MapPin className="size-4" aria-hidden />,
          },
        ]
      : []),
  ];
  const scope = destination === SEA ? "" : destination;

  return (
    <Form action={EXPLORE_PATH} className="grid gap-5" data-search-form data-testid="explore-form">
      <fieldset className="grid content-start gap-2">
        <legend className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          <Globe2 className="text-primary size-4" aria-hidden />
          {t("whereTitle")}
        </legend>
        <div className="flex flex-wrap gap-2" data-testid="explore-where">
          {places.map((place) => (
            <Choice
              key={place.value || "anywhere"}
              on={destination === place.value}
              onPick={() => setDestination(place.value)}
              className={cn("flex items-center gap-1.5", place.value === "" && "sm:px-4")}
              testId={`explore-where-${place.value || "anywhere"}`}
            >
              {place.icon}
              {place.label}
            </Choice>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {destination === "" ? t("anywhereHint") : t("whereHint")}
        </p>
        {scope && <input type="hidden" name="to" value={scope} />}
        {destination === SEA && <input type="hidden" name="cat" value="sea" />}
      </fieldset>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="explore-from-0" className="text-muted-foreground text-xs font-medium">
            {t("from")}
          </Label>
          <PlaceInput
            id="explore-from-0"
            name="from"
            value={from}
            onChange={setFrom}
            placeholder={tSearch("fromPlaceholder")}
            icon={<PlaneTakeoff />}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="explore-date" className="text-muted-foreground text-xs font-medium">
            {t("when")}
          </Label>
          <Input
            id="explore-date"
            type="date"
            required
            min={today}
            className={FIELD_CLASS}
            value={center}
            onChange={(e) => setCenter(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset className="grid content-start gap-2">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">
            {t("tolerance")}
          </legend>
          <div className="flex flex-wrap gap-2" data-testid="explore-tolerance">
            {toleranceOptions.map((days) => (
              <Choice key={days} on={tolerance === days} onPick={() => setTolerance(days)}>
                {days === 0 ? t("exactDate") : t("plusMinus", { days })}
              </Choice>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t("toleranceHint")}</p>
        </fieldset>
        <fieldset className="grid content-start gap-2">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">{t("nights")}</legend>
          <div className="flex flex-wrap gap-2" data-testid="explore-nights">
            {nightOptions.map((option) => {
              const [a, b] = option.split("-").map(Number);
              return (
                <Choice key={option} on={nights === option} onPick={() => setNights(option)}>
                  {a === b ? t("nightsExact", { count: a }) : t("nightsRange", { min: a, max: b })}
                </Choice>
              );
            })}
          </div>
        </fieldset>
      </div>
      <input type="hidden" name="depart" value={range.depart} />
      <input type="hidden" name="until" value={range.until} />
      <input type="hidden" name="nmin" value={nmin} />
      <input type="hidden" name="nmax" value={nmax} />

      <details className="group grid gap-3 rounded-lg border px-3 py-2" open={advanced}>
        <summary className="text-muted-foreground hover:text-primary cursor-pointer text-sm font-medium select-none">
          {t("more")}
        </summary>
        <div className="grid gap-4 pt-3 pb-1">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={t("budget", { currency })} htmlFor="explore-budget">
              <Input
                id="explore-budget"
                name="budget"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder={t("anyBudget")}
                className={FIELD_CLASS}
                defaultValue={initial?.budget ?? ""}
              />
            </Field>
            <Field label={t("currency")} htmlFor="explore-cur">
              <select
                id="explore-cur"
                name="cur"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={SELECT_CLASS}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("adults")} htmlFor="explore-adults">
              <select
                id="explore-adults"
                name="adults"
                defaultValue={initial?.adults ?? 1}
                className={SELECT_CLASS}
              >
                {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset className="grid gap-1.5">
              <legend className="text-muted-foreground mb-1.5 text-xs font-medium">
                {t("mode")}
              </legend>
              <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1 text-xs">
                {(["flights", "trip"] as const).map((mode) => (
                  <label
                    key={mode}
                    className="has-[:checked]:bg-card has-[:checked]:text-primary text-muted-foreground has-[:focus-visible]:ring-ring/40 cursor-pointer rounded-md px-2 py-1.5 text-center font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-3"
                  >
                    <input
                      type="radio"
                      name="mode"
                      value={mode}
                      defaultChecked={(initial?.mode ?? "flights") === mode}
                      className="sr-only"
                    />
                    {t(`modes.${mode}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <fieldset className="grid content-start gap-2">
            <legend className="text-muted-foreground mb-1 text-xs font-medium">
              {t("categories")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.filter((c) => !(destination === SEA && c === "sea")).map((category) => (
                <label key={category} className={cn(CHIP, "px-3 py-1 text-xs")}>
                  <input
                    type="checkbox"
                    name="cat"
                    value={category}
                    defaultChecked={extraCategories.includes(category)}
                    className="sr-only"
                  />
                  {tCat(category)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="direct"
                value="1"
                defaultChecked={initial?.direct_only ?? false}
                className="size-4"
              />
              {tSearch("directOnly")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="wk"
                value="1"
                defaultChecked={initial?.weekends ?? false}
                className="size-4"
              />
              {t("weekends")}
            </label>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-xl gap-1">
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
          <EntryNotice />
        </div>
        <SubmitButton idle={t("submit")} pending={t("searching")} />
      </div>
    </Form>
  );
}

/**
 * Вибір-перемикач (куди, похибка, ночі): кнопка з `aria-pressed`, а не радіо — у форму не
 * потрапляє; у URL ідуть лише приховані `to`/`cat`/`depart`/`until`/`nmin`/`nmax`.
 */
function Choice({
  on,
  onPick,
  className,
  testId,
  children,
}: {
  on: boolean;
  onPick: () => void;
  className?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
        on ? "border-primary bg-primary/10 text-primary" : "hover:border-primary/60",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </button>
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
      data-testid="explore-submit"
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
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-medium">
        {label}
      </Label>
      {children}
    </div>
  );
}
