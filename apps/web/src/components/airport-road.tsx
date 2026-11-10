"use client";

import type { TripQuery } from "@tickets/shared";
import { TrainFront } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_AIRPORT_ROAD, withAirportRoad } from "@/lib/trip-params";
import { FIELD_CLASS } from "@/lib/styles";
import { toYourTrip } from "@/lib/trip-params";

/**
 * Дорога до аеропорту (етап 4, ADR 0048): даних про громадський транспорт у нас немає, тож
 * вартість вводить людина — на всіх, туди й назад. У розбивці — окремо від бронювання й
 * орієнтовно; сума поїздки перераховується (новий запит з `road=`, з кешу джерел).
 */
export function AirportRoad({
  query,
  saved,
  currency,
}: {
  query: TripQuery;
  saved?: string | null;
  currency: string;
}) {
  const t = useTranslations("tripInsights.road");
  const router = useRouter();
  const [value, setValue] = useState(query.airport_road != null ? String(query.airport_road) : "");
  const amount = Number(value);
  const valid =
    value !== "" && Number.isFinite(amount) && amount >= 0 && amount <= MAX_AIRPORT_ROAD;

  return (
    <form
      className="grid gap-2 border-t pt-3"
      data-testid="airport-road"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid)
          router.push(toYourTrip(withAirportRoad(query, amount, saved)), { scroll: false });
      }}
    >
      <label htmlFor="airport-road" className="flex items-center gap-1.5 text-xs font-medium">
        <TrainFront className="text-primary size-3.5" aria-hidden />
        {t("label", { currency })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="airport-road"
          type="number"
          min={0}
          max={MAX_AIRPORT_ROAD}
          step="any"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("placeholder")}
          className={`${FIELD_CLASS} h-9 w-32`}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!valid}>
          {query.airport_road != null ? t("update") : t("add")}
        </Button>
        {query.airport_road != null && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              router.push(toYourTrip(withAirportRoad(query, null, saved)), { scroll: false })
            }
          >
            {t("remove")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-[11px]">{t("hint")}</p>
    </form>
  );
}
