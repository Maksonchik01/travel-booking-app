"use client";

import type { TripQuery } from "@tickets/shared";
import { Loader2, PlaneLanding, PlaneTakeoff, Search } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { PlaceInput, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addDays, BAGGAGE_NEEDS, CABINS, CURRENCIES, MAX_PERIOD_DAYS } from "@/lib/search-params";
import { MAX_NIGHTS, nightsBetween } from "@/lib/stay-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import {
  MAX_EXTRAS,
  TRIP_DISTANCES,
  TRIP_PROFILES,
  TRIP_RATINGS,
  type TripExtra,
} from "@/lib/trip-params";

/**
 * Поїздка: звідки, куди, дати туди й назад, люди, бюджет. GET-форма — працює й без JS.
 * `initial` може бути неповним: «Додати до поїздки» з житла знає місто, дати й житло.
 */
export function TripSearchForm({
  initial,
  saved,
}: {
  initial: Partial<TripQuery> | null;
  /** Редагування збереженої поїздки (`saved=`) — переживає новий пошук із форми. */
  saved?: string | null;
}) {
  const t = useTranslations("tripForm");
  const tSearch = useTranslations("search");
  const [from, setFrom] = useState(() => placeValue(initial?.origin));
  const [to, setTo] = useState(() => placeValue(initial?.destination));
  const [depart, setDepart] = useState(initial?.departure_date ?? "");
  const [back, setBack] = useState(initial?.return_date ?? "");
  const nights = depart && back ? nightsBetween(depart, back) : 0;
  const [currency, setCurrency] = useState<string>(initial?.currency ?? "EUR");
  const stayFilters = initial?.stay_filters;
  const extras: (TripExtra | null)[] = [...(initial?.extras ?? [])];
  while (extras.length < Math.min(MAX_EXTRAS, (initial?.extras?.length ?? 0) + 2)) {
    extras.push(null);
  }
  // Розкрито, якщо щось із прихованого вже задано — інакше людина не побачить своїх умов.
  const advanced = Boolean(
    initial?.departure_until ||
    initial?.min_nights ||
    (initial?.baggage && initial.baggage !== "none") ||
    (initial?.cabin && initial.cabin !== "economy") ||
    stayFilters?.min_rating ||
    stayFilters?.free_cancellation ||
    stayFilters?.breakfast_included ||
    stayFilters?.max_distance_center_km ||
    initial?.extras?.length,
  );

  return (
    <Form action="/trip" className="grid gap-4" data-search-form>
      {saved && <input type="hidden" name="saved" value={saved} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tSearch("from")} htmlFor="trip-from">
          <PlaceInput
            id="trip-from"
            name="from"
            value={from}
            onChange={setFrom}
            placeholder={tSearch("fromPlaceholder")}
            icon={<PlaneTakeoff />}
          />
        </Field>
        <Field label={tSearch("to")} htmlFor="trip-to">
          <PlaceInput
            id="trip-to"
            name="to"
            value={to}
            onChange={setTo}
            placeholder={tSearch("toPlaceholder")}
            icon={<PlaneLanding />}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label={tSearch("depart")} htmlFor="trip-depart">
          <Input
            id="trip-depart"
            name="depart"
            type="date"
            required
            className={FIELD_CLASS}
            value={depart}
            onChange={(e) => {
              setDepart(e.target.value);
              if (e.target.value && (!back || back <= e.target.value)) {
                setBack(addDays(e.target.value, 3));
              }
            }}
          />
        </Field>
        <Field
          label={tSearch("return")}
          hint={nights > 0 ? t("nights", { count: nights }) : t("returnHint")}
          htmlFor="trip-return"
        >
          <Input
            id="trip-return"
            name="return"
            type="date"
            className={FIELD_CLASS}
            min={depart ? addDays(depart, 1) : undefined}
            max={depart ? addDays(depart, MAX_NIGHTS) : undefined}
            value={back}
            onChange={(e) => setBack(e.target.value)}
          />
        </Field>
        <Field label={t("adults")} htmlFor="trip-adults">
          <select
            id="trip-adults"
            name="adults"
            defaultValue={initial?.adults ?? 2}
            className={SELECT_CLASS}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("children")} htmlFor="trip-children">
          <select
            id="trip-children"
            name="children"
            defaultValue={initial?.children ?? 0}
            className={SELECT_CLASS}
          >
            {Array.from({ length: 9 }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("currency")} htmlFor="trip-cur">
          <select
            id="trip-cur"
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
        <Field label={t("budget", { currency })} htmlFor="trip-budget">
          <Input
            id="trip-budget"
            name="budget"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={t("anyBudget")}
            className={FIELD_CLASS}
            defaultValue={initial?.budget_total ?? ""}
          />
        </Field>
      </div>

      <details className="group grid gap-3 rounded-lg border px-3 py-2" open={advanced}>
        <summary className="text-muted-foreground hover:text-primary cursor-pointer text-sm font-medium select-none">
          {t("more")}
        </summary>
        <div className="grid gap-4 pt-3 pb-1">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={t("until")} htmlFor="trip-until">
              <Input
                id="trip-until"
                name="until"
                type="date"
                className={FIELD_CLASS}
                min={depart || undefined}
                max={depart ? addDays(depart, MAX_PERIOD_DAYS) : undefined}
                defaultValue={initial?.departure_until ?? ""}
              />
            </Field>
            <Field label={t("nightsFrom")} htmlFor="trip-nmin">
              <NightsSelect id="trip-nmin" name="nmin" value={initial?.min_nights} any={t("any")} />
            </Field>
            <Field label={t("nightsTo")} htmlFor="trip-nmax">
              <NightsSelect id="trip-nmax" name="nmax" value={initial?.max_nights} any={t("any")} />
            </Field>
            <p className="text-muted-foreground col-span-2 self-end text-xs sm:col-span-1">
              {t("nightsHint")}
            </p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-semibold tracking-wide uppercase">
              {t("flightWishes")}
            </legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label={t("baggage")} htmlFor="trip-bag">
                <select
                  id="trip-bag"
                  name="bag"
                  defaultValue={initial?.baggage ?? "none"}
                  className={SELECT_CLASS}
                >
                  {BAGGAGE_NEEDS.map((b) => (
                    <option key={b} value={b}>
                      {tSearch(`bags.${b}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("cabin")} htmlFor="trip-cabin">
                <select
                  id="trip-cabin"
                  name="cabin"
                  defaultValue={initial?.cabin ?? "economy"}
                  className={SELECT_CLASS}
                >
                  {CABINS.map((c) => (
                    <option key={c} value={c}>
                      {tSearch(`cabins.${c}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-semibold tracking-wide uppercase">
              {t("stayWishes")}
            </legend>
            <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
              <Field label={t("rating")} htmlFor="trip-rating">
                <select
                  id="trip-rating"
                  name="rating"
                  defaultValue={stayFilters?.min_rating ?? ""}
                  className={SELECT_CLASS}
                >
                  <option value="">{t("any")}</option>
                  {TRIP_RATINGS.map((r) => (
                    <option key={r} value={r}>
                      {r}+
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("distance")} htmlFor="trip-dist">
                <select
                  id="trip-dist"
                  name="dist"
                  defaultValue={stayFilters?.max_distance_center_km ?? ""}
                  className={SELECT_CLASS}
                >
                  <option value="">{t("any")}</option>
                  {TRIP_DISTANCES.map((km) => (
                    <option key={km} value={km}>
                      {t("km", { km })}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="cancel"
                  value="1"
                  defaultChecked={stayFilters?.free_cancellation ?? false}
                  className="size-4"
                />
                {t("freeCancellation")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="bfast"
                  value="1"
                  defaultChecked={stayFilters?.breakfast_included ?? false}
                  className="size-4"
                />
                {t("breakfast")}
              </label>
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-semibold tracking-wide uppercase">
              {t("extras")}
            </legend>
            {extras.map((extra, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem] gap-2">
                <Input
                  name="xl"
                  aria-label={t("extraLabel")}
                  placeholder={t("extraLabel")}
                  maxLength={40}
                  className={FIELD_CLASS}
                  defaultValue={extra?.label ?? ""}
                />
                <Input
                  name="xa"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  aria-label={t("extraAmount", { currency })}
                  placeholder={t("extraAmount", { currency })}
                  className={FIELD_CLASS}
                  defaultValue={extra?.amount ?? ""}
                />
              </div>
            ))}
            <p className="text-muted-foreground text-xs">{t("extrasHint")}</p>
          </fieldset>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex items-center gap-2 text-sm">
            <legend className="text-muted-foreground float-left mr-2 text-xs font-medium">
              {t("priority")}
            </legend>
            <div className="bg-muted inline-flex rounded-lg p-1">
              {TRIP_PROFILES.map((profile) => (
                <label
                  key={profile}
                  className="text-muted-foreground hover:text-foreground has-[:checked]:bg-card has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 transition-all has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
                >
                  <input
                    type="radio"
                    name="prio"
                    value={profile}
                    defaultChecked={(initial?.profile ?? "balanced") === profile}
                    className="sr-only"
                  />
                  {t(`priorities.${profile}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="hover:text-primary flex cursor-pointer items-center gap-2 text-sm transition-colors">
            <input
              type="checkbox"
              name="direct"
              value="1"
              defaultChecked={initial?.direct_only ?? false}
              className="size-4"
            />
            {tSearch("directOnly")}
          </label>
          {initial?.flight && (
            <label
              className="flex items-start gap-2 text-sm"
              title={t("pinnedFlightHint")}
              data-testid="trip-pinned-flight"
            >
              <input
                type="checkbox"
                name="flight"
                value={initial.flight}
                defaultChecked
                className="mt-0.5 size-4"
              />
              <span className="grid">
                {t("pinnedFlight")}
                <span className="text-muted-foreground text-xs">{t("pinnedFlightHint")}</span>
              </span>
            </label>
          )}
          {initial?.stay && (
            <label
              className="flex items-start gap-2 text-sm"
              title={t("pinnedHint")}
              data-testid="trip-pinned-stay"
            >
              <input
                type="checkbox"
                name="stay"
                value={initial.stay}
                defaultChecked
                className="mt-0.5 size-4"
              />
              <span className="grid">
                {t("pinnedStay")}
                <span className="text-muted-foreground text-xs">{t("pinnedHint")}</span>
              </span>
            </label>
          )}
        </div>
        <SubmitButton idle={t("submit")} pending={t("searching")} />
      </div>
    </Form>
  );
}

function NightsSelect({
  id,
  name,
  value,
  any,
}: {
  id: string;
  name: string;
  value: number | null | undefined;
  any: string;
}) {
  return (
    <select id={id} name={name} defaultValue={value ?? ""} className={SELECT_CLASS}>
      <option value="">{any}</option>
      {Array.from({ length: MAX_NIGHTS }, (_, i) => i + 1).map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
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
