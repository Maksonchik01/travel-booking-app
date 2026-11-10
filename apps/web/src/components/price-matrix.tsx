import type { MatrixCell, PriceMatrix as Matrix } from "@tickets/shared";
import { Grid3x3 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { InfoHint } from "@/components/info-hint";

import { type SearchState, toSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

const MOBILE_COMBOS = 6;

/**
 * Матриця туди-назад (модуль 2c): по горизонталі — дата вильоту, по вертикалі — дата
 * повернення, у клітинці — загальна кешована ціна. Клік — пошук наживо на ці дати.
 * На вузькому екрані — список найдешевших комбінацій замість таблиці.
 */
export function PriceMatrix({ matrix, state }: { matrix: Matrix; state: SearchState }) {
  const t = useTranslations("matrix");
  const format = useFormatter();
  if (matrix.cells.length === 0) return null;
  const cells = new Map(matrix.cells.map((c) => [`${c.departure}|${c.return_date}`, c]));
  const min = Math.min(...matrix.cells.map((c) => c.price));
  const { departure_date: dep, return_date: ret } = state.query;
  const day = (iso: string, weekday = true) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      ...(weekday ? { weekday: "short" } : {}),
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const money = (c: MatrixCell) =>
    format.number(c.price, {
      style: "currency",
      currency: c.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(c.price),
    });
  const href = (c: MatrixCell) =>
    `/?${toSearchParams({
      ...state,
      query: {
        ...state.query,
        departure_date: c.departure,
        return_date: c.return_date,
        flex_days: 0,
        departure_until: null,
        min_nights: null,
        max_nights: null,
      },
    })}`;
  const cheapestCombos = [...matrix.cells]
    .sort((a, b) => a.price - b.price || a.departure.localeCompare(b.departure))
    .slice(0, MOBILE_COMBOS);

  return (
    <section
      className="bg-card grid gap-3 rounded-xl border p-4 shadow-xs"
      aria-labelledby="matrix-title"
    >
      <div className="grid gap-0.5">
        <h2 id="matrix-title" className="flex items-center gap-2 text-sm font-semibold">
          <Grid3x3 className="text-primary size-4" aria-hidden />
          {t("title")}
        </h2>
        <InfoHint label={t("how")}>
          <p>{t("hint")}</p>
        </InfoHint>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table
          className="w-full border-separate border-spacing-1 text-center text-xs"
          data-testid="matrix"
        >
          <thead>
            <tr>
              <th scope="col" className="text-muted-foreground p-1 text-left font-normal">
                {t("corner")}
              </th>
              {matrix.departures.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className={cn("p-1 font-medium whitespace-nowrap", d === dep && "text-primary")}
                >
                  {day(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.returns.map((r) => (
              <tr key={r}>
                <th
                  scope="row"
                  className={cn(
                    "p-1 text-left font-medium whitespace-nowrap",
                    r === ret && "text-primary",
                  )}
                >
                  {day(r)}
                </th>
                {matrix.departures.map((d) => {
                  const cell = cells.get(`${d}|${r}`);
                  const current = d === dep && r === ret;
                  if (!cell) {
                    return (
                      <td key={d} className="text-muted-foreground/60 rounded-md p-1.5">
                        {r < d ? "" : "—"}
                      </td>
                    );
                  }
                  return (
                    <td key={d} className="p-0">
                      <Link
                        href={href(cell)}
                        data-testid="matrix-cell"
                        title={t("cellTitle", { from: day(d, false), to: day(r, false) })}
                        className={cn(
                          "hover:border-primary/50 block rounded-md border px-1.5 py-1.5 tabular-nums transition-colors",
                          current && "border-primary bg-primary text-primary-foreground",
                          !current &&
                            cell.price === min &&
                            "border-success/50 bg-emerald-50 font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
                        )}
                      >
                        {money(cell)}
                      </Link>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ol className="grid gap-1.5 sm:hidden" data-testid="matrix-list">
        {cheapestCombos.map((c) => (
          <li key={`${c.departure}|${c.return_date}`}>
            <Link
              href={href(c)}
              className={cn(
                "hover:border-primary/50 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                c.price === min && "border-success/50 bg-success/5",
              )}
            >
              <span>
                {day(c.departure)} – {day(c.return_date)}
              </span>
              <span className="font-semibold tabular-nums">{money(c)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
