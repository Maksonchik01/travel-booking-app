"use client";

import { Building2, Loader2, Search } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { PlaceInput, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addDays } from "@/lib/search-params";
import { MAX_NIGHTS, nightsBetween, STAY_PROFILES, type StayState } from "@/lib/stay-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";

/** Пошук житла: місто, дати, гості, що важливіше. Звичайна GET-форма — працює й без JS. */
export function StaySearchForm({ initial }: { initial: StayState | null }) {
  const t = useTranslations("stays");
  const q = initial?.query;
  const [city, setCity] = useState(() => placeValue(q?.city));
  const [checkIn, setCheckIn] = useState(q?.check_in ?? "");
  const [checkOut, setCheckOut] = useState(q?.check_out ?? "");
  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : 0;

  return (
    <Form action="/stays" className="grid gap-4">
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
            defaultValue={q?.guests?.adults ?? 2}
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
            defaultValue={q?.guests?.children ?? 0}
            className={SELECT_CLASS}
          >
            {Array.from({ length: 9 }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

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
                  defaultChecked={(q?.profile ?? "balanced") === profile}
                  className="sr-only"
                />
                {t(`priorities.${profile}`)}
              </label>
            ))}
          </div>
        </fieldset>
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
