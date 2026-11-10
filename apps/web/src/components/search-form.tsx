"use client";

import { ArrowLeftRight, Compass, Loader2, PlaneLanding, PlaneTakeoff, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { ParamsToggle } from "@/components/params-toggle";
import { PassengerPicker } from "@/components/passenger-picker";
import { exploreFromFlights } from "@/lib/explore-params";
import { readLocalFilters } from "@/lib/saved-filters";
import type { FlightDefaults } from "@/lib/search-prefs";
import { useHydrated } from "@/lib/use-hydrated";
import { PlaceInput, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FLEX_OPTIONS,
  MAX_NIGHTS,
  NEARBY_RADIUS_KM,
  PROFILES,
  type SearchState,
  toSearchParams,
} from "@/lib/search-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

export function SearchForm({
  initial,
  savedFilters = null,
  defaults = null,
}: {
  initial: SearchState | null;
  /** Збережені в профілі фільтри (рядок URL); гостю — з браузера після гідратації. */
  savedFilters?: string | null;
  /** Налаштування профілю для нового пошуку (модуль 10b); пошук з URL їх не бере. */
  defaults?: FlightDefaults | null;
}) {
  const t = useTranslations("search");
  const q = initial?.query;
  const d = q ? null : defaults;
  const [depart, setDepart] = useState(q?.departure_date ?? d?.departure ?? "");
  const [from, setFrom] = useState(() => placeValue(q?.origin ?? d?.origin ?? undefined));
  const [to, setTo] = useState(() => placeValue(q?.destination ?? d?.destination));
  const [fromNear, setFromNear] = useState(!!q?.origin_radius_km);
  const [toNear, setToNear] = useState(!!q?.destination_radius_km);
  // Новий пошук — туди й назад (найчастіше); відкритий з URL — як у ньому.
  const [roundTrip, setRoundTrip] = useState(
    q ? !!q.return_date : d?.departure ? !!d.returnDate : true,
  );
  const [flex, setFlex] = useState(initialFlex(q));
  // Пошук за кількістю ночей (2b): місяць чи період туди й назад — без дати повернення.
  const nightsMode = roundTrip && (flex === "month" || flex === "range");

  function swap() {
    setFrom(to);
    setTo(from);
    setFromNear(toNear);
    setToNear(fromNear);
  }

  return (
    <Form action="/" className="grid gap-4" data-search-form>
      <fieldset className="flex items-center gap-2 text-sm">
        <legend className="sr-only">{t("tripType")}</legend>
        <div className="bg-muted inline-flex rounded-lg p-1">
          {(["rt", "ow"] as const).map((trip) => (
            <label
              key={trip}
              className="text-muted-foreground hover:text-foreground has-[:checked]:bg-card has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 transition-all has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
            >
              {/* Без JS сервер ігнорує повернення при trip=ow; з JS поле просто вимкнене. */}
              <input
                type="radio"
                name="trip"
                value={trip}
                checked={roundTrip === (trip === "rt")}
                onChange={() => setRoundTrip(trip === "rt")}
                className="sr-only"
              />
              {t(trip === "rt" ? "roundTrip" : "oneWay")}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label={t("from")} htmlFor="from">
          <PlaceInput
            id="from"
            name="from"
            value={from}
            onChange={setFrom}
            placeholder={t("fromPlaceholder")}
            icon={<PlaneTakeoff />}
          />
          <NearbyToggle name="fromNear" checked={fromNear} onChange={setFromNear} />
        </Field>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={swap}
          aria-label={t("swap")}
          className="group/swap bg-card hover:border-primary/50 hover:text-primary -my-2 size-9 justify-self-center rounded-full shadow-xs sm:mt-7 sm:mb-0 sm:self-start"
        >
          <ArrowLeftRight className="size-4 rotate-90 transition-transform duration-300 group-hover/swap:rotate-[270deg] sm:rotate-0 sm:group-hover/swap:rotate-180" />
        </Button>
        <Field label={t("to")} htmlFor="to">
          <PlaceInput
            id="to"
            name="to"
            value={to}
            onChange={setTo}
            placeholder={t("toPlaceholder")}
            icon={<PlaneLanding />}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <NearbyToggle name="toNear" checked={toNear} onChange={setToNear} />
            <AnywhereLink />
          </div>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t("depart")} htmlFor="depart">
          <Input
            id="depart"
            name="depart"
            type="date"
            required
            className={FIELD_CLASS}
            value={depart}
            onChange={(e) => setDepart(e.target.value)}
          />
        </Field>
        <Field label={t("return")} htmlFor="return">
          <Input
            id="return"
            name="return"
            type="date"
            min={depart || undefined}
            required={roundTrip && !nightsMode}
            disabled={!roundTrip || nightsMode}
            className={cn(FIELD_CLASS, (!roundTrip || nightsMode) && "opacity-50")}
            defaultValue={q?.return_date ?? d?.returnDate ?? ""}
          />
        </Field>
        <Field label={t("flex")} htmlFor="flex">
          <select
            id="flex"
            name="flex"
            value={flex}
            onChange={(e) => setFlex(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="0">{t("flexExact")}</option>
            {[...new Set([...FLEX_OPTIONS.slice(1), q?.flex_days ?? 0])]
              .filter((days) => days > 0)
              .sort((a, b) => a - b)
              .map((days) => (
                <option key={days} value={days}>
                  {t("flexDays", { days })}
                </option>
              ))}
            <option value="month">{t("flexMonth")}</option>
            <option value="range">{t("flexRange")}</option>
          </select>
          {flex === "range" && (
            <Input
              type="date"
              name="until"
              aria-label={t("flexUntil")}
              min={depart || undefined}
              required
              className={cn(FIELD_CLASS, "mt-1.5")}
              defaultValue={q?.departure_until ?? ""}
            />
          )}
        </Field>
        <div className="grid gap-1.5">
          <span className="text-muted-foreground text-xs font-medium">{t("passengers")}</span>
          <PassengerPicker
            passengers={
              q?.passengers ??
              (d?.adults
                ? { adults: d.adults, children: d.children ?? 0, infants: 0, infants_in_seat: 0 }
                : undefined)
            }
            cabin={q?.cabin ?? d?.cabin ?? undefined}
            baggage={q?.baggage ?? d?.baggage ?? undefined}
            currency={q?.currency ?? d?.currency ?? undefined}
          />
        </div>
      </div>

      {nightsMode && <NightsFields q={q} />}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex items-center gap-2 text-sm">
            <legend className="text-muted-foreground float-left mr-2 text-xs font-medium">
              {t("profile")}
            </legend>
            <div className="bg-muted inline-flex rounded-lg p-1">
              {PROFILES.map((profile) => (
                <label
                  key={profile}
                  className="text-muted-foreground hover:text-foreground has-[:checked]:bg-card has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 transition-all has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
                >
                  <input
                    type="radio"
                    name="profile"
                    value={profile}
                    defaultChecked={(q?.profile ?? d?.profile ?? "balanced") === profile}
                    className="sr-only"
                  />
                  {t(`profiles.${profile}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="hover:text-primary flex cursor-pointer items-center gap-2 text-sm transition-colors">
            <input
              type="checkbox"
              name="direct"
              value="1"
              defaultChecked={q?.direct_only ?? false}
              className="accent-primary size-4"
            />
            {t("directOnly")}
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SavedFilters fromAccount={savedFilters} />
          <SubmitButton idle={t("submit")} pending={t("searching")} />
        </div>
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

function NearbyToggle({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations("search");
  return (
    <label className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-2 text-xs transition-colors">
      <input
        type="checkbox"
        name={name}
        value="1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary size-3.5"
      />
      {t("nearby", { km: NEARBY_RADIUS_KM })}
    </label>
  );
}

/**
 * «Будь-куди» (ADR 0045): Explore з тим, що вже введено у форму (звідки, дати, люди, «прямі»,
 * валюта). Без JS — просто сторінка Explore.
 */
function AnywhereLink() {
  const t = useTranslations("search");
  const router = useRouter();
  return (
    <Link
      href="/explore"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        const form = event.currentTarget.closest("form");
        if (!form) return;
        event.preventDefault();
        router.push(exploreFromFlights(new FormData(form)));
      }}
      className="text-primary flex items-center gap-1 text-xs font-medium hover:underline"
      data-testid="search-anywhere"
    >
      <Compass className="size-3.5" aria-hidden />
      {t("anywhere")}
    </Link>
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
        {hint && <span className="font-normal opacity-70">· {hint}</span>}
      </Label>
      {children}
    </div>
  );
}

/**
 * Збережені фільтри: додаються до нового пошуку прихованими полями, поки позначку не знято.
 * З акаунта — одразу (і без JS); гостю — з localStorage після гідратації.
 */
function SavedFilters({ fromAccount }: { fromAccount: string | null }) {
  const t = useTranslations("search");
  const hydrated = useHydrated();
  const saved = fromAccount ?? (hydrated ? readLocalFilters() : "");
  const entries = [...new URLSearchParams(saved)];
  return <ParamsToggle entries={entries} label={t("useSavedFilters", { count: entries.length })} />;
}

/** Режим гнучкості для поля форми — так само, як його пише URL (`flex=`). */
function initialFlex(q: SearchState["query"] | undefined): string {
  if (!q) return "0";
  return q.departure_until
    ? (toSearchParams({ query: q, sort: "price" }).get("flex") ?? "range")
    : String(q.flex_days ?? 0);
}

/** Скільки ночей на місці й бюджет — для «3–5 ночей у грудні» (модуль 2b). */
function NightsFields({ q }: { q: SearchState["query"] | undefined }) {
  const t = useTranslations("search");
  const options = Array.from({ length: MAX_NIGHTS }, (_, i) => i + 1);
  return (
    <fieldset className="grid gap-3 sm:grid-cols-3" data-testid="nights-fields">
      <legend className="sr-only">{t("nights")}</legend>
      <Field label={t("nightsFrom")} htmlFor="nmin">
        <select id="nmin" name="nmin" defaultValue={q?.min_nights ?? 3} className={SELECT_CLASS}>
          {options.map((n) => (
            <option key={n} value={n}>
              {t("nightsCount", { count: n })}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("nightsTo")} htmlFor="nmax">
        <select id="nmax" name="nmax" defaultValue={q?.max_nights ?? 5} className={SELECT_CLASS}>
          {options.map((n) => (
            <option key={n} value={n}>
              {t("nightsCount", { count: n })}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("tripBudget", { currency: q?.currency ?? "EUR" })} htmlFor="maxt">
        <Input
          id="maxt"
          name="maxt"
          type="number"
          min={1}
          inputMode="numeric"
          placeholder={t("anyBudget")}
          defaultValue={q?.filters?.max_total_price ?? ""}
          className={FIELD_CLASS}
        />
      </Field>
    </fieldset>
  );
}
