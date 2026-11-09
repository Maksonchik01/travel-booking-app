import type { CalendarDay } from "@tickets/shared";
import { BadgeCheck, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { LinkPendingOverlay } from "@/components/pending";
import { daysAgo, hoursAgo } from "@/lib/format";
import { type SearchState, toSearchParams, withDepartureDate } from "@/lib/search-params";
import { cn } from "@/lib/utils";

const HIGHLIGHT = 3;

/**
 * Календар цін (модуль 2c): найнижча кешована ціна в один бік на кожен день місяця.
 * Місяці гортаються (`cal=`) без зміни пошуку; клік по дню — пошук на цю дату. Найдешевші
 * дні підсвічено, різниця — відносно обраного дня, вік ціни — у підказці; ✓ — ціну на цей
 * день щойно підтвердило живе джерело (`verified`: дата → ціна).
 */
export function PriceCalendar({
  month,
  days,
  state,
  now,
  verified = {},
}: {
  month: string;
  days: CalendarDay[];
  state: SearchState;
  now: Date;
  verified?: Record<string, number>;
}) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const prices = days.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const cheapestDates = new Set(
    [...days]
      .sort((a, b) => a.price - b.price || a.date.localeCompare(b.date))
      .slice(0, HIGHLIGHT)
      .map((d) => d.date),
  );
  const selectedPrice = byDate.get(state.query.departure_date)?.price ?? null;
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const monthDate = new Date(Date.UTC(year, monthIndex - 1, 1));
  const thisMonth = now.toISOString().slice(0, 7);
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
    return d.toISOString().slice(0, 7);
  };
  const monthHref = (value: string) => `/?${toSearchParams(state)}&cal=${value}#calendar`;
  const money = (value: number, currency: string) =>
    format.number(value, {
      style: "currency",
      currencyDisplay: "narrowSymbol",
      currency,
      maximumFractionDigits: 0,
    });

  return (
    <section
      id="calendar"
      className="bg-card grid scroll-mt-20 gap-3 rounded-xl border p-4 shadow-xs"
      aria-labelledby="calendar-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id="calendar-title" className="flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="text-primary size-4" aria-hidden />
            {t("title", { month: format.dateTime(monthDate, { month: "long", year: "numeric" }) })}
          </h2>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
        </div>
        <nav className="flex items-center gap-1" aria-label={t("months")}>
          {shift(-1) >= thisMonth && (
            <Link
              href={monthHref(shift(-1))}
              className="hover:border-primary/50 rounded-md border p-1.5"
              aria-label={t("prevMonth")}
              scroll={false}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Link>
          )}
          <Link
            href={monthHref(shift(1))}
            className="hover:border-primary/50 rounded-md border p-1.5"
            aria-label={t("nextMonth")}
            scroll={false}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </nav>
      </div>
      {days.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pt-1 pb-2">
          <ol className="flex min-w-max gap-1.5">
            {Array.from({ length: daysInMonth }, (_, i) => {
              const date = `${month}-${String(i + 1).padStart(2, "0")}`;
              const day = byDate.get(date);
              const selected = date === state.query.departure_date;
              const cheapest = day && day.price === min;
              const top = day && cheapestDates.has(date);
              const live = verified[date];
              // 0 — найдешевший день місяця, 1 — найдорожчий: для фону-підказки.
              const level = day && max > min ? (day.price - min) / (max - min) : 0;
              const diff =
                day && selectedPrice != null && !selected ? day.price - selectedPrice : null;
              const href = `/?${toSearchParams(withDepartureDate(state, date))}`;
              const weekday = format.dateTime(new Date(`${date}T00:00:00Z`), {
                weekday: "short",
                timeZone: "UTC",
              });
              const age = day
                ? day.found_at
                  ? t("foundHours", { hours: hoursAgo(day.found_at, now) })
                  : day.found_on
                    ? t("foundDays", { days: daysAgo(day.found_on, now) })
                    : t("foundUnknown")
                : null;
              const content = (
                <>
                  <span className="text-muted-foreground text-[10px] uppercase">{weekday}</span>
                  <span className="text-sm font-medium tabular-nums">{i + 1}</span>
                  <span className="text-[11px] tabular-nums">
                    {day ? money(day.price, day.currency) : "—"}
                  </span>
                  {diff != null && diff !== 0 && (
                    <span
                      className={cn(
                        "text-[10px] tabular-nums",
                        diff < 0 ? "text-success" : "text-rose-700 dark:text-rose-400",
                      )}
                      data-testid="calendar-diff"
                    >
                      {diff > 0 ? "+" : "−"}
                      {Math.abs(Math.round(diff))}
                    </span>
                  )}
                  {live != null && (
                    <BadgeCheck
                      className="absolute top-0.5 right-0.5 size-3 text-success"
                      aria-label={t("verified")}
                    />
                  )}
                </>
              );
              const className = cn(
                "relative flex w-14 flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition-all duration-150",
                selected
                  ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/25 [&_span]:text-primary-foreground"
                  : "bg-card border-border",
                day &&
                  !selected &&
                  "hover:border-primary/50 hover:-translate-y-0.5 hover:shadow-sm",
                !day && "opacity-45",
                !selected &&
                  cheapest &&
                  "border-success/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
                !selected && top && !cheapest && "border-emerald-500/30 bg-emerald-500/[0.06]",
                !selected && day && !top && level > 0.66 && "bg-rose-500/[0.04]",
              );
              const title = day
                ? [
                    cheapest ? t("cheapest") : null,
                    t("cachedAge", { age: age ?? "" }),
                    live != null ? t("verifiedPrice", { price: money(live, day.currency) }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t("noData");
              return (
                <li key={date}>
                  {day ? (
                    <Link
                      href={href}
                      className={className}
                      aria-current={selected ? "date" : undefined}
                      title={title}
                      data-testid="calendar-day"
                      data-cheap={top ? "true" : undefined}
                    >
                      {content}
                      <LinkPendingOverlay />
                    </Link>
                  ) : (
                    <div className={className} title={title}>
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm border border-success/50 bg-emerald-50 dark:bg-emerald-500/15" />
          {t("legendCheap")}
        </span>
        <span className="flex items-center gap-1">
          <BadgeCheck className="size-3 text-success" aria-hidden />
          {t("legendVerified")}
        </span>
        <span>{t("legendCached")}</span>
      </p>
    </section>
  );
}
