import type { CalendarDay } from "@tickets/shared";
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
    <section className="grid gap-2" aria-labelledby="calendar-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="calendar-title" className="text-sm font-medium">
          {t("title", { month: format.dateTime(monthDate, { month: "long", year: "numeric" }) })}
        </h2>
        <p className="text-muted-foreground text-xs">{t("hint")}</p>
      </div>
      <div className="overflow-x-auto pb-1">
        <ol className="flex min-w-max gap-1">
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
              "flex w-14 flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 transition-colors",
              selected ? "border-primary ring-primary/30 ring-2" : "border-transparent",
              day ? "hover:border-foreground/30" : "opacity-50",
              cheapest && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
              day && !cheapest && level < 0.34 && "bg-emerald-500/5",
              day && level > 0.66 && "bg-rose-500/5",
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
