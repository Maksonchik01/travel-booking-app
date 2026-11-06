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
import { addDays } from "@/lib/search-params";
import { MAX_NIGHTS, nightsBetween } from "@/lib/stay-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { TRIP_PROFILES } from "@/lib/trip-params";

/** Поїздка: звідки, куди, дати туди й назад, люди, бюджет. GET-форма — працює й без JS. */
export function TripSearchForm({ initial }: { initial: TripQuery | null }) {
  const t = useTranslations("tripForm");
  const tSearch = useTranslations("search");
  const [from, setFrom] = useState(() => placeValue(initial?.origin));
  const [to, setTo] = useState(() => placeValue(initial?.destination));
  const [depart, setDepart] = useState(initial?.departure_date ?? "");
  const [back, setBack] = useState(initial?.return_date ?? "");
  const nights = depart && back ? nightsBetween(depart, back) : 0;

  return (
    <Form action="/trip" className="grid gap-4">
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
          hint={nights > 0 ? t("nights", { count: nights }) : undefined}
          htmlFor="trip-return"
        >
          <Input
            id="trip-return"
            name="return"
            type="date"
            required
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
        <Field label={t("budget")} htmlFor="trip-budget">
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
        </div>
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
