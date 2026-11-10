"use client";

import type { ExploreQuery } from "@tickets/shared";
import { Loader2, Plus, PlaneTakeoff, Search, X } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { DatePresets } from "@/components/date-presets";
import { PlaceInput, type PlaceValue, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CATEGORIES,
  DEFAULT_NIGHTS,
  EXPLORE_PATH,
  MAX_EXPLORE_NIGHTS,
  MAX_ORIGINS,
  MAX_SPAN_DAYS,
  NIGHT_PRESETS,
  REGIONS,
} from "@/lib/explore-params";
import { type DatePreset, datePreset, shiftDay } from "@/lib/date-presets";
import { CURRENCIES } from "@/lib/search-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

/**
 * Explore (ADR 0045): звідки (до трьох аеропортів), куди (будь-куди / регіон / країна), коли
 * (точні дати чи гнучко — період і ночі, швидкі варіанти), хто, бюджет і тип пошуку.
 * GET-форма — працює й без JS; категорії й прямі — у «Більше налаштувань».
 */
export function ExploreForm({
  initial,
  countries,
  today,
}: {
  initial: Partial<ExploreQuery> | null;
  /** Країни довідника з назвами мовою сторінки (рахує сервер: ICU браузера може відрізнятись). */
  countries: { code: string; name: string }[];
  /** Сьогодні (YYYY-MM-DD) — для швидких дат. */
  today: string;
}) {
  const t = useTranslations("explore.form");
  const tCat = useTranslations("explore.category");
  const tRegion = useTranslations("explore.region");
  const tSearch = useTranslations("search");
  const [from, setFrom] = useState<PlaceValue[]>(() =>
    (initial?.origins?.length ? initial.origins : [""]).map((code) =>
      placeValue(code || undefined),
    ),
  );
  const [exact, setExact] = useState(Boolean(initial?.return_date));
  const [depart, setDepart] = useState(initial?.departure_date ?? shiftDay(today, 14));
  const [until, setUntil] = useState(
    initial?.departure_until ?? shiftDay(initial?.departure_date ?? today, 44),
  );
  const [back, setBack] = useState(
    initial?.return_date ?? shiftDay(initial?.departure_date ?? shiftDay(today, 14), 3),
  );
  const [nights, setNights] = useState(
    `${initial?.min_nights ?? DEFAULT_NIGHTS[0]}-${initial?.max_nights ?? DEFAULT_NIGHTS[1]}`,
  );
  const [weekends, setWeekends] = useState(initial?.weekends ?? false);
  const [currency, setCurrency] = useState<string>(initial?.currency ?? "EUR");
  const [nmin, nmax] = nights.split("-");
  const nightOptions = useMemo(() => {
    const options = NIGHT_PRESETS.map(([a, b]) => `${a}-${b}`);
    return options.includes(nights) ? options : [...options, nights];
  }, [nights]);

  const scope = initial?.region ?? initial?.country ?? "";
  const advanced = Boolean(initial?.direct_only || initial?.categories?.length);

  function applyPreset(preset: DatePreset) {
    const next = datePreset(preset, today);
    setDepart(next.depart);
    if (next.back) {
      setExact(true);
      setBack(next.back);
      setWeekends(false);
      return;
    }
    setExact(false);
    if (next.until) setUntil(next.until);
    if (next.nights) setNights(`${next.nights[0]}-${next.nights[1]}`);
    setWeekends(Boolean(next.weekends));
  }

  return (
    <Form action={EXPLORE_PATH} className="grid gap-4" data-search-form data-testid="explore-form">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <fieldset className="grid gap-1.5">
          <legend className="text-muted-foreground mb-1.5 text-xs font-medium">{t("from")}</legend>
          <div className="grid gap-2">
            {from.map((value, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <PlaceInput
                    id={`explore-from-${i}`}
                    name="from"
                    value={value}
                    onChange={(next) => setFrom((all) => all.map((v, j) => (j === i ? next : v)))}
                    placeholder={i === 0 ? tSearch("fromPlaceholder") : t("morePlaceholder")}
                    icon={<PlaneTakeoff />}
                  />
                </div>
                {from.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFrom((all) => all.filter((_, j) => j !== i))}
                    aria-label={t("removeOrigin", { code: value.code || i + 1 })}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-9 shrink-0 place-items-center rounded-lg"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {from.length < MAX_ORIGINS && (
              <button
                type="button"
                onClick={() => setFrom((all) => [...all, placeValue(undefined)])}
                className="text-primary flex w-fit items-center gap-1 text-xs font-medium hover:underline"
                data-testid="explore-add-origin"
              >
                <Plus className="size-3.5" aria-hidden />
                {t("addOrigin")}
              </button>
            )}
          </div>
        </fieldset>
        <Field label={t("to")} htmlFor="explore-to">
          <select id="explore-to" name="to" defaultValue={scope} className={SELECT_CLASS}>
            <option value="">{t("anywhere")}</option>
            <optgroup label={t("regions")}>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {tRegion(r)}
                </option>
              ))}
            </optgroup>
            {countries.length > 0 && (
              <optgroup label={t("countries")}>
                {countries.map(({ code, name }) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1 text-sm" role="group">
            {[false, true].map((isExact) => (
              <button
                key={String(isExact)}
                type="button"
                onClick={() => setExact(isExact)}
                aria-pressed={exact === isExact}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  exact === isExact
                    ? "bg-card text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {isExact ? t("exact") : t("flexible")}
              </button>
            ))}
          </div>
          <DatePresets onPick={applyPreset} testId="explore-presets" />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={exact ? tSearch("depart") : t("departFrom")} htmlFor="explore-depart">
            <Input
              id="explore-depart"
              name="depart"
              type="date"
              required
              min={today}
              className={FIELD_CLASS}
              value={depart}
              onChange={(e) => setDepart(e.target.value)}
            />
          </Field>
          {exact ? (
            <Field label={tSearch("return")} htmlFor="explore-return">
              <Input
                id="explore-return"
                name="return"
                type="date"
                required
                className={FIELD_CLASS}
                min={depart ? shiftDay(depart, 1) : undefined}
                max={depart ? shiftDay(depart, MAX_EXPLORE_NIGHTS) : undefined}
                value={back}
                onChange={(e) => setBack(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label={t("departUntil")} htmlFor="explore-until">
                <Input
                  id="explore-until"
                  name="until"
                  type="date"
                  required
                  className={FIELD_CLASS}
                  min={depart || undefined}
                  max={depart ? shiftDay(depart, MAX_SPAN_DAYS) : undefined}
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </Field>
              <Field label={t("nights")} htmlFor="explore-nights">
                <select
                  id="explore-nights"
                  value={nights}
                  onChange={(e) => setNights(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {nightOptions.map((option) => {
                    const [a, b] = option.split("-");
                    return (
                      <option key={option} value={option}>
                        {t("nightsRange", { min: Number(a), max: Number(b) })}
                      </option>
                    );
                  })}
                </select>
                <input type="hidden" name="nmin" value={nmin} />
                <input type="hidden" name="nmax" value={nmax} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2.5 text-sm">
                <input
                  type="checkbox"
                  name="wk"
                  value="1"
                  checked={weekends}
                  onChange={(e) => setWeekends(e.target.checked)}
                  className="size-4"
                />
                {t("weekends")}
              </label>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
        <fieldset className="grid gap-1.5">
          <legend className="text-muted-foreground mb-1.5 text-xs font-medium">{t("mode")}</legend>
          <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1 text-xs sm:text-sm">
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

      <details className="group grid gap-3 rounded-lg border px-3 py-2" open={advanced}>
        <summary className="text-muted-foreground hover:text-primary cursor-pointer text-sm font-medium select-none">
          {t("more")}
        </summary>
        <div className="grid gap-3 pt-3 pb-1">
          <fieldset className="grid gap-2">
            <legend className="text-muted-foreground mb-1 text-xs font-medium">
              {t("categories")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((category) => (
                <label
                  key={category}
                  className="has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:focus-visible]:ring-ring/40 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium has-[:focus-visible]:ring-3"
                >
                  <input
                    type="checkbox"
                    name="cat"
                    value={category}
                    defaultChecked={initial?.categories?.includes(category) ?? false}
                    className="sr-only"
                  />
                  {tCat(category)}
                </label>
              ))}
            </div>
          </fieldset>
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
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-xl text-xs">{t("hint")}</p>
        <SubmitButton idle={t("submit")} pending={t("searching")} />
      </div>
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
