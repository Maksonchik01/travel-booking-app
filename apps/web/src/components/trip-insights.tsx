import type {
  TripAlternative,
  TripCombo,
  TripDifference,
  TripQuery,
  TripSearchResult,
} from "@tickets/shared";
import { ArrowRight, Clock, Lightbulb, Sparkles } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { fractionDigits } from "@/lib/money";
import { toYourTrip, withChoice } from "@/lib/trip-params";
import { cn } from "@/lib/utils";

const GOOD = new Set<TripDifference["code"]>([
  "cheaper",
  "direct",
  "fewer_stops",
  "faster",
  "more_city_time",
  "higher_rating",
  "closer",
]);

/**
 * Відмінності варіанта (етап 4, ADR 0048): «Дешевше на 35 €», «Прямий рейс замість пересадки»…
 * Рахує код (`trip_insights.py`); тут лише підписи. Плюси — зеленим, мінуси — як є.
 */
export function DifferenceList({
  differences,
  currency,
}: {
  differences: TripDifference[];
  currency: string;
}) {
  const t = useTranslations("tripInsights.diff");
  const format = useFormatter();
  if (differences.length === 0) return null;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const hours = (minutes: number) =>
    format.number(minutes / 60, { maximumFractionDigits: minutes % 60 ? 1 : 0 });
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="trip-differences">
      {differences.map((d) => (
        <li
          key={d.code}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            GOOD.has(d.code) ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {t(d.code, {
            amount: money(d.amount ?? 0),
            hours: hours(d.minutes ?? 0),
            count: d.count ?? 0,
            days: d.days ?? 0,
            rating: format.number(d.rating ?? 0, { maximumFractionDigits: 1 }),
            km: format.number(d.km ?? 0, { maximumFractionDigits: 1 }),
          })}
        </li>
      ))}
    </ul>
  );
}

/** Підказка-альтернатива: заголовок за типом, відмінності, «Застосувати» → «Ваша поїздка». */
function AlternativeCard({
  alternative,
  combo,
  query,
  saved,
  testId,
}: {
  alternative: TripAlternative;
  combo: TripCombo;
  query: TripQuery;
  saved?: string | null;
  testId: string;
}) {
  const t = useTranslations("tripInsights");
  const Icon = alternative.kind === "better" ? Sparkles : Lightbulb;
  return (
    <div className="bg-card grid gap-2 rounded-xl border p-3.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="text-primary size-4 shrink-0" aria-hidden />
        {t(`kind.${alternative.kind}`)}
      </p>
      <DifferenceList differences={alternative.differences} currency={combo.currency} />
      <Button asChild size="sm" variant="outline" className="w-fit">
        <Link
          href={toYourTrip(
            withChoice(query, { flight: combo.offer_key, stay: combo.stay_key }, saved),
          )}
          data-testid={`${testId}-apply`}
        >
          {t("apply")}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </Button>
    </div>
  );
}

/** До двох підказок після пошуку (етап 4): з реально знайдених комбінацій, з кнопкою «Застосувати». */
export function TripRecommendations({
  data,
  query,
  saved,
}: {
  data: TripSearchResult;
  query: TripQuery;
  saved?: string | null;
}) {
  const t = useTranslations("tripInsights");
  const combos = new Map((data.combos ?? []).map((c) => [c.key, c]));
  const items = (data.recommendations ?? []).filter((r) => combos.has(r.combo_key));
  if (items.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="trip-hints-title" data-testid="trip-hints">
      <h3 id="trip-hints-title" className="text-sm font-semibold">
        {t("hintsTitle")}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((r) => (
          <AlternativeCard
            key={r.combo_key}
            alternative={r}
            combo={combos.get(r.combo_key)!}
            query={query}
            saved={saved}
            testId="trip-hint"
          />
        ))}
      </div>
    </section>
  );
}

/** «Краще в межах бюджету» (етап 4): серед уже знайдених — без нових запитів. */
export function TripBetter({
  data,
  query,
  saved,
}: {
  data: TripSearchResult;
  query: TripQuery;
  saved?: string | null;
}) {
  const t = useTranslations("tripInsights");
  const combo = data.better
    ? (data.combos ?? []).find((c) => c.key === data.better!.combo_key)
    : null;
  if (!data.better || !combo) {
    return (
      <p className="text-muted-foreground text-xs" data-testid="trip-better-none">
        {query.budget_total != null ? t("betterNoneBudget") : t("betterNone")}
      </p>
    );
  }
  return (
    <AlternativeCard
      alternative={data.better}
      combo={combo}
      query={query}
      saved={saved}
      testId="trip-better"
    />
  );
}

/** Корисний час (етап 4): днів, ночей і годин у місті — від посадки до вильоту назад. */
export function CityTime({ combo }: { combo: TripCombo }) {
  const t = useTranslations("tripInsights");
  const format = useFormatter();
  const start = Date.parse(
    `${(combo.arrival_at ?? combo.return_departure_at).slice(0, 10)}T00:00:00Z`,
  );
  const end = Date.parse(`${combo.return_departure_at.slice(0, 10)}T00:00:00Z`);
  const days = combo.arrival_at ? Math.round((end - start) / 86_400_000) + 1 : null;
  return (
    <p
      className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs"
      data-testid="trip-city-time"
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      {days != null && <span>{t("days", { count: days })} · </span>}
      <span>{t("nights", { count: combo.window.nights })}</span>
      {combo.city_minutes != null ? (
        <span title={t("cityHint")}>
          {" · "}
          {t("cityHours", {
            hours: format.number(combo.city_minutes / 60, { maximumFractionDigits: 0 }),
          })}
        </span>
      ) : (
        <span> · {t("cityUnknown")}</span>
      )}
    </p>
  );
}
