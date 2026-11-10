import type { Stay, StayPick, StayScore, StayScoringResult } from "@tickets/shared";
import { ChevronRight, Scale, Star, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { InfoHint } from "@/components/info-hint";

import { RatingBadge, StayScoreDetails } from "@/components/stay-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

const LABEL_ICON = { cheapest: Wallet, top_rated: Star, balanced: Scale } as const;

export function stayAnchor(key: string) {
  return `stay-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** Три варіанти value-score: найдешевший, збалансований, найкращий рейтинг. */
export function StayPicks({
  scoring,
  stays,
  children,
}: {
  scoring: StayScoringResult;
  stays: Stay[];
  /** Під картками — резюме відгуків від ШІ (якщо увімкнено). */
  children?: React.ReactNode;
}) {
  const t = useTranslations("stayPicks");
  const tPrio = useTranslations("stays.priorities");
  const byKey = new Map(stays.map((s) => [`${s.source}:${s.id}`, s]));
  const scores = new Map(scoring.scores.map((s) => [s.stay_key, s]));
  const picks = scoring.picks.filter((p) => byKey.has(p.stay_key));
  if (picks.length === 0) return null;

  return (
    <section className="grid gap-3" aria-labelledby="stay-picks-title">
      <div className="grid gap-1">
        <h2 id="stay-picks-title" className="text-xl font-semibold tracking-tight">
          {t("title")}
        </h2>
        <InfoHint label={t("how")}>
          <p>{t("formula", { priority: tPrio(scoring.profile) })}</p>
        </InfoHint>
      </div>
      <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        {picks.map((pick) => (
          <li key={pick.stay_key}>
            <PickCard
              pick={pick}
              stay={byKey.get(pick.stay_key)!}
              score={scores.get(pick.stay_key)}
            />
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}

function PickCard({ pick, stay, score }: { pick: StayPick; stay: Stay; score?: StayScore }) {
  const t = useTranslations("stayPicks");
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  const Icon = LABEL_ICON[pick.label];
  const recommended = pick.label === "balanced";
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: stay.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });

  return (
    <Card
      className={cn(
        "lift h-full gap-3 py-4",
        recommended
          ? "border-primary/50 from-primary/[0.07] to-card bg-gradient-to-b"
          : "hover:border-primary/30",
      )}
      data-testid="stay-top-pick"
      data-label={pick.label}
    >
      <CardHeader className="gap-1 px-4">
        <div className="flex items-center gap-2 font-medium">
          <span
            className={cn(
              "grid size-7 place-items-center rounded-lg",
              recommended ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          {t(`label.${pick.label}`)}
        </div>
        {pick.also && pick.also.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("also", { labels: format.list(pick.also.map((l) => t(`alsoLabel.${l}`))) })}
          </p>
        )}
      </CardHeader>
      <CardContent className="grid gap-2.5 px-4">
        <p className="leading-tight font-semibold">{stay.name}</p>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-bold tracking-tight tabular-nums">
            {money(stay.price_per_night)}
          </span>
          <span className="text-muted-foreground text-xs">{tCard("perNight")}</span>
        </div>
        <RatingBadge rating={stay.rating ?? null} reviews={stay.review_count ?? 0} />
        {stay.distance_to_center_km != null && (
          <p className="text-muted-foreground text-xs">
            {tCard("toCenter", { km: format.number(stay.distance_to_center_km) })}
          </p>
        )}
        {score && (
          <details className="group text-xs">
            <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {tCard("whyScore")}
            </summary>
            <div className="mt-2">
              <StayScoreDetails score={score} money={money} />
            </div>
          </details>
        )}
        <a
          href={`#${stayAnchor(pick.stay_key)}`}
          className="text-primary mt-auto w-fit text-xs font-medium underline-offset-4 hover:underline"
        >
          {t("details")}
        </a>
      </CardContent>
    </Card>
  );
}
