"use client";

import { ArrowLeftRight, Loader2, Search } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { PlaceInput, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_FLEX_DAYS, NEARBY_RADIUS_KM, PROFILES, type SearchState } from "@/lib/search-params";

const selectClass =
  "border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function SearchForm({ initial }: { initial: SearchState | null }) {
  const t = useTranslations("search");
  const q = initial?.query;
  const [depart, setDepart] = useState(q?.departure_date ?? "");
  const [from, setFrom] = useState(() => placeValue(q?.origin));
  const [to, setTo] = useState(() => placeValue(q?.destination));
  const [fromNear, setFromNear] = useState(!!q?.origin_radius_km);
  const [toNear, setToNear] = useState(!!q?.destination_radius_km);

  function swap() {
    setFrom(to);
    setTo(from);
    setFromNear(toNear);
    setToNear(fromNear);
  }

  return (
    <Form action="/" className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label={t("from")} htmlFor="from">
          <PlaceInput
            id="from"
            name="from"
            value={from}
            onChange={setFrom}
            placeholder={t("fromPlaceholder")}
          />
          <NearbyToggle name="fromNear" checked={fromNear} onChange={setFromNear} />
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={swap}
          aria-label={t("swap")}
          className="-my-2 justify-self-center sm:mt-6 sm:mb-0 sm:self-start"
        >
          <ArrowLeftRight className="size-4 rotate-90 sm:rotate-0" />
        </Button>
        <Field label={t("to")} htmlFor="to">
          <PlaceInput
            id="to"
            name="to"
            value={to}
            onChange={setTo}
            placeholder={t("toPlaceholder")}
          />
          <NearbyToggle name="toNear" checked={toNear} onChange={setToNear} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t("depart")} htmlFor="depart">
          <Input
            id="depart"
            name="depart"
            type="date"
            required
            value={depart}
            onChange={(e) => setDepart(e.target.value)}
          />
        </Field>
        <Field label={t("return")} hint={t("returnOptional")} htmlFor="return">
          <Input
            id="return"
            name="return"
            type="date"
            min={depart || undefined}
            defaultValue={q?.return_date ?? ""}
          />
        </Field>
        <Field label={t("flex")} htmlFor="flex">
          <select id="flex" name="flex" defaultValue={q?.flex_days ?? 0} className={selectClass}>
            <option value={0}>{t("flexExact")}</option>
            {Array.from({ length: MAX_FLEX_DAYS }, (_, i) => i + 1).map((days) => (
              <option key={days} value={days}>
                {t("flexDays", { days })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("adults")} htmlFor="adults">
          <select
            id="adults"
            name="adults"
            defaultValue={q?.passengers?.adults ?? 1}
            className={selectClass}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex items-center gap-2 text-sm">
            <legend className="text-muted-foreground float-left mr-2 text-xs font-medium">
              {t("profile")}
            </legend>
            <div className="bg-muted inline-flex rounded-md p-0.5">
              {PROFILES.map((profile) => (
                <label
                  key={profile}
                  className="has-[:checked]:bg-background has-[:checked]:shadow-xs has-[:focus-visible]:ring-ring/50 cursor-pointer rounded px-3 py-1 has-[:checked]:font-medium has-[:focus-visible]:ring-[3px]"
                >
                  <input
                    type="radio"
                    name="profile"
                    value={profile}
                    defaultChecked={(q?.profile ?? "balanced") === profile}
                    className="sr-only"
                  />
                  {t(`profiles.${profile}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
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
        <SubmitButton idle={t("submit")} pending={t("searching")} />
      </div>
    </Form>
  );
}

function SubmitButton({ idle, pending }: { idle: string; pending: string }) {
  const status = useFormStatus();
  return (
    <Button type="submit" size="lg" className="min-w-36" disabled={status.pending}>
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
    <label className="text-muted-foreground flex w-fit items-center gap-2 text-xs">
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
