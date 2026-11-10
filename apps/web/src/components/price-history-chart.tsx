"use client";

import type { PriceSeries } from "@tickets/shared";
import { LineChart } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { fractionDigits } from "@/lib/money";

const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

/**
 * Історія цін (етап 6, ADR 0050): найнижча побачена ціна на кожен день спостереження — лише
 * збережені дані, без інтерполяції. Один ряд: колір — токен теми, легенди немає (назва в
 * заголовку), підказка при наведенні чи фокусі, таблиця тих самих даних — під спойлером.
 * Менше трьох днів — лише чесне «даних ще мало».
 */
export function PriceHistoryChart({
  series,
  title,
  testId = "price-history",
}: {
  series: PriceSeries;
  title: string;
  testId?: string;
}) {
  const t = useTranslations("priceHistory");
  const format = useFormatter();
  const [active, setActive] = useState<number | null>(null);
  const points = series.points;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: series.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  if (!series.enough) {
    return (
      <p className="text-muted-foreground text-xs" data-testid={`${testId}-few`}>
        {points.length === 0 ? t("none") : t("few", { count: points.length })}
      </p>
    );
  }

  const prices = points.map((p) => p.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // Запас над і під лінією; рівна лінія — умовний діапазон ±5 %.
  const span = high - low || Math.max(1, high * 0.1);
  const min = low - span * 0.15;
  const max = high + span * 0.15;
  const times = points.map((p) => Date.parse(`${p.day}T00:00:00Z`));
  const first = times[0];
  const last = times[times.length - 1];
  const x = (i: number) =>
    PAD.left +
    (last === first ? 0.5 : (times[i] - first) / (last - first)) * (WIDTH - PAD.left - PAD.right);
  const y = (price: number) =>
    PAD.top + (1 - (price - min) / (max - min)) * (HEIGHT - PAD.top - PAD.bottom);
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`)
    .join(" ");
  const ticks = [...new Set([low, (low + high) / 2, high])];
  const current = active != null ? points[active] : null;
  const latest = points[points.length - 1];
  const change = latest.price - points[0].price;

  return (
    <figure className="grid gap-2" data-testid={testId}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <LineChart className="text-primary size-4" aria-hidden />
          {title}
        </span>
        <span className="text-muted-foreground text-xs">
          {low === high
            ? t("flat", { price: money(low), days: points.length })
            : t("summary", { low: money(low), high: money(high), days: points.length })}
          {" · "}
          {change === 0
            ? t("same")
            : t(change < 0 ? "down" : "up", { amount: money(Math.abs(change)) })}
        </span>
      </figcaption>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full min-w-[22rem]"
          // group, а не img: усередині — точки з фокусом (підказка з клавіатури).
          role="group"
          aria-label={t("aria", { low: money(low), high: money(high), days: points.length })}
          onMouseLeave={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {money(tick)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={HEIGHT - 8} className="fill-muted-foreground text-[11px]">
            {day(points[0].day)}
          </text>
          <text
            x={WIDTH - PAD.right}
            y={HEIGHT - 8}
            textAnchor="end"
            className="fill-muted-foreground text-[11px]"
          >
            {day(latest.day)}
          </text>
          {current && active != null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}
          <path
            d={path}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {points.map((p, i) => (
            <g key={p.day}>
              <circle
                cx={x(i)}
                cy={y(p.price)}
                r={4}
                fill="var(--primary)"
                stroke="var(--card)"
                strokeWidth={2}
              />
              {/* Ціль наведення — ширша за точку. */}
              <rect
                x={x(i) - 12}
                y={PAD.top}
                width={24}
                height={HEIGHT - PAD.top - PAD.bottom}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={t("point", { day: day(p.day), price: money(p.price) })}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          ))}
        </svg>
        {current && active != null && (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute top-1 rounded-md border px-2 py-1 text-xs shadow-md"
            style={{
              left: `${(x(active) / WIDTH) * 100}%`,
              transform: `translateX(${active > points.length / 2 ? "-100%" : "0"})`,
            }}
            role="status"
          >
            <span className="font-semibold tabular-nums">{money(current.price)}</span>{" "}
            <span className="text-muted-foreground">
              {day(current.day)} · {t("observations", { count: current.observations })}
            </span>
          </div>
        )}
      </div>
      <details className="text-xs">
        <summary className="text-muted-foreground hover:text-primary w-fit cursor-pointer select-none">
          {t("table")}
        </summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                {t("day")}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                {t("lowest")}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day} className="border-t">
                <td className="py-1">{day(p.day)}</td>
                <td className="py-1 text-right tabular-nums">{money(p.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="text-muted-foreground text-[11px]">{t("note")}</p>
    </figure>
  );
}
