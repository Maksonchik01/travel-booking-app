import { ArrowRight, Lightbulb } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import type { DateHint } from "@/lib/flight-hints";
import { fractionDigits } from "@/lib/money";

/** Підказка після пошуку рейсів (етап 4): інші дати помітно дешевші — з кнопкою «Застосувати». */
export function FlightDateHint({ hint }: { hint: DateHint | null }) {
  const t = useTranslations("tripInsights");
  const format = useFormatter();
  if (!hint) return null;
  const amount = format.number(hint.saving, {
    style: "currency",
    currency: hint.option.currency,
    currencyDisplay: "narrowSymbol",
    ...fractionDigits(hint.saving),
  });
  return (
    <div
      className="bg-accent/50 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
      data-testid="flight-date-hint"
    >
      <p className="flex items-center gap-2">
        <Lightbulb className="text-primary size-4 shrink-0" aria-hidden />
        {hint.shift === 0
          ? t("flightOtherReturn", { amount })
          : t(hint.shift < 0 ? "flightEarlier" : "flightLater", {
              days: Math.abs(hint.shift),
              amount,
            })}
      </p>
      <Link
        href={hint.href}
        className="text-primary flex items-center gap-1 font-medium hover:underline"
      >
        {t("apply")}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
