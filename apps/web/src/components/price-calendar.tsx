import type { CalendarDay } from "@tickets/shared";
import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { LinkPendingOverlay } from "@/components/pending";
import { cn } from "@/lib/utils";
import { type SearchState, toSearchParams, withDepartureDate } from "@/lib/search-params";

/** Смуга днів місяця з найнижчою ціною; клік — пошук на цю дату. */
export function PriceCalendar({
  month,
  days,
  state,
}: {
  month: string;
  days: CalendarDay[];
  state: SearchState;
}) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const prices = days.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const monthDate = new Date(Date.UTC(year, monthIndex - 1, 1));

  return (
    <section
      className="bg-card grid gap-3 rounded-xl border p-4 shadow-xs"
      aria-labelledby="calendar-title"
    >
      <div className="grid gap-0.5">
        <h2 id="calendar-title" className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays className="text-primary size-4" aria-hidden />
          {t("title", { month: format.dateTime(monthDate, { month: "long", year: "numeric" }) })}
        </h2>
        <p className="text-muted-foreground text-xs">{t("hint")}</p>
      </div>
      <div className="-mx-1 overflow-x-auto px-1 pt-1 pb-2">
        <ol className="flex min-w-max gap-1.5">
          {Array.from({ length: daysInMonth }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, "0")}`;
            const day = byDate.get(date);
            const selected = date === state.query.departure_date;
            const cheapest = day && day.price === min;
            // 0 — найдешевший день місяця, 1 — найдорожчий: для фону-підказки.
            const level = day && max > min ? (day.price - min) / (max - min) : 0;
            const href = `/?${toSearchParams(withDepartureDate(state, date))}`;
            const weekday = format.dateTime(new Date(`${date}T00:00:00Z`), {
              weekday: "short",
              timeZone: "UTC",
            });
            const content = (
              <>
                <span className="text-muted-foreground text-[10px] uppercase">{weekday}</span>
                <span className="text-sm font-medium tabular-nums">{i + 1}</span>
                <span className="text-[11px] tabular-nums">
                  {day
                    ? format.number(day.price, {
                        style: "currency",
                        currencyDisplay: "narrowSymbol",
                        currency: day.currency,
                        maximumFractionDigits: 0,
                      })
                    : "—"}
                </span>
              </>
            );
            const className = cn(
              "flex w-14 flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition-all duration-150",
              selected
                ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/25 [&_span]:text-primary-foreground"
                : "bg-card border-border",
              day && !selected && "hover:border-primary/50 hover:-translate-y-0.5 hover:shadow-sm",
              !day && "opacity-45",
              !selected &&
                cheapest &&
                "border-emerald-500/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
              !selected && day && !cheapest && level < 0.34 && "bg-emerald-500/[0.04]",
              !selected && day && level > 0.66 && "bg-rose-500/[0.04]",
            );
            return (
              <li key={date}>
                {day ? (
                  <Link
                    href={href}
                    className={cn(className, "relative")}
                    aria-current={selected ? "date" : undefined}
                    title={cheapest ? t("cheapest") : undefined}
                    data-testid="calendar-day"
                  >
                    {content}
                    <LinkPendingOverlay />
                  </Link>
                ) : (
                  <div className={className} title={t("noData")}>
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
