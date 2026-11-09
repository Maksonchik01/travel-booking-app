import type { DateOption } from "@tickets/shared";
import { BadgeCheck, CalendarRange, History } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { daysAgo, hoursAgo } from "@/lib/format";
import { type SearchState, toSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

const SHOWN = 8;

/**
 * Гнучкі дати (модуль 2a): найкраща ціна на кожну пару дат. «Перевірено наживо» — ціну на
 * ці дати щойно підтвердило живе джерело; решта — кешовані ціни з віком (ADR 0016).
 * Клік — пошук саме на ці дати.
 */
export function DateOptions({
  options,
  state,
  now,
}: {
  options: DateOption[];
  state: SearchState;
  now: Date;
}) {
  const t = useTranslations("dateOptions");
  const format = useFormatter();
  if (options.length < 2) return null;
  const cheapest = Math.min(...options.map((o) => o.price));
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  return (
    <section
      className="bg-card grid gap-3 rounded-xl border p-4 shadow-xs"
      aria-labelledby="dates-title"
    >
      <div className="grid gap-1">
        <h2 id="dates-title" className="flex items-center gap-2 font-semibold">
          <CalendarRange className="text-primary size-4" aria-hidden />
          {t("title")}
        </h2>
        <p className="text-muted-foreground text-xs">{t("hint")}</p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {options.slice(0, SHOWN).map((o) => {
          const href = `/?${toSearchParams({
            ...state,
            query: {
              ...state.query,
              departure_date: o.departure,
              return_date: o.return_date ?? null,
              flex_days: 0,
              departure_until: null,
            },
          })}`;
          const age = o.found_at
            ? t("foundHours", { hours: hoursAgo(o.found_at, now) })
            : o.found_on
              ? t("foundDays", { days: daysAgo(o.found_on, now) })
              : t("foundUnknown");
          return (
            <li key={`${o.departure}|${o.return_date}`}>
              <Link
                href={href}
                data-testid="date-option"
                className={cn(
                  "hover:border-primary/50 lift grid gap-1 rounded-lg border p-3 text-sm transition-colors",
                  o.price === cheapest && "border-success/50 bg-success/5",
                )}
              >
                <span className="font-medium">
                  {day(o.departure)}
                  {o.return_date && ` – ${day(o.return_date)}`}
                </span>
                {o.nights != null && (
                  <span className="text-muted-foreground text-xs" data-testid="nights">
                    {t(o.nights_approximate ? "nightsApprox" : "nights", { count: o.nights })}
                  </span>
                )}
                <span className="text-lg font-bold tabular-nums">
                  {format.number(o.price, {
                    style: "currency",
                    currency: o.currency,
                    currencyDisplay: "narrowSymbol",
                    ...fractionDigits(o.price),
                  })}
                </span>
                {o.verified ? (
                  <span className="flex items-center gap-1 text-xs text-success">
                    <BadgeCheck className="size-3.5" aria-hidden />
                    {t("verified")}
                  </span>
                ) : (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <History className="size-3.5" aria-hidden />
                    {t("cached", { age })}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
