import type { Offer, OfferScore, Pick, ScoringResult } from "@tickets/shared";
import { AlertTriangle, Info, Scale, Timer, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { splitDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL_ICON = { cheapest: Wallet, fastest: Timer, balanced: Scale } as const;

export function offerAnchor(key: string) {
  return `offer-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** Три Pareto-варіанти з розбивкою оцінки: видно, чому кожен такий. */
export function TopPicks({ scoring, offers }: { scoring: ScoringResult; offers: Offer[] }) {
  const t = useTranslations("picks");
  const tProfile = useTranslations("search.profiles");
  const offersByKey = new Map(offers.map((o) => [`${o.source}:${o.id}`, o]));
  const scoresByKey = new Map(scoring.scores.map((s) => [s.offer_key, s]));
  const picks = scoring.picks.filter((p) => offersByKey.has(p.offer_key));
  if (picks.length === 0) return null;

  return (
    <section className="grid gap-3" aria-labelledby="picks-title">
      <div className="grid gap-1">
        <h2 id="picks-title" className="text-xl font-semibold tracking-tight">
          {t("title")}
        </h2>
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("formula", { profile: tProfile(scoring.profile) })}
        </p>
      </div>
      <ol className="grid gap-3 md:grid-cols-3">
        {picks.map((pick) => (
          <li key={pick.offer_key}>
            <PickCard
              pick={pick}
              offer={offersByKey.get(pick.offer_key)!}
              score={scoresByKey.get(pick.offer_key)}
            />
          </li>
        ))}
      </ol>
      {scoring.unscored_offer_keys.length > 0 && (
        <p className="text-muted-foreground text-xs">{t("unscored")}</p>
      )}
    </section>
  );
}

function PickCard({ pick, offer, score }: { pick: Pick; offer: Offer; score?: OfferScore }) {
  const t = useTranslations("picks");
  const tOffer = useTranslations("offer");
  const format = useFormatter();
  const Icon = LABEL_ICON[pick.label];
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: offer.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    });
  const duration =
    offer.total_duration_min != null ? splitDuration(offer.total_duration_min) : null;

  return (
    <Card
      className={cn(
        "h-full gap-3 py-4",
        pick.label === "balanced" && "border-primary/60 ring-primary/15 ring-2",
      )}
      data-testid="top-pick"
      data-label={pick.label}
    >
      <CardHeader className="gap-1 px-4">
        <div className="flex items-center gap-2 font-medium">
          <Icon className="size-4" aria-hidden />
          {t(`label.${pick.label}`)}
        </div>
        {pick.also.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("also", {
              labels: format.list(pick.also.map((l) => t(`alsoLabel.${l}`))),
            })}
          </p>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums">{money(offer.price)}</span>
          <span className="text-muted-foreground text-right text-xs">
            {duration
              ? tOffer("duration", {
                  hours: duration.hours,
                  minutes: String(duration.minutes).padStart(2, "0"),
                })
              : tOffer("durationUnknown")}
            <br />
            {offer.stops === 0 ? tOffer("direct") : tOffer("stops", { count: offer.stops })}
          </span>
        </div>

        {score && <ScoreDetails score={score} money={money} />}

        <a
          href={`#${offerAnchor(pick.offer_key)}`}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          {t("details")}
        </a>
      </CardContent>
    </Card>
  );
}

/** Розбивка оцінки: ціна + штрафи = оцінка, плюс попередження. Спільна для карток. */
export function ScoreDetails({
  score,
  money,
}: {
  score: OfferScore;
  money: (v: number) => string;
}) {
  const t = useTranslations("picks");
  const b = score.breakdown;
  const plus = (value: number | null) =>
    value == null ? t("breakdown.unknown") : value === 0 ? money(0) : `+${money(value)}`;

  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs" data-testid="breakdown">
        <dt className="text-muted-foreground">{t("breakdown.price")}</dt>
        <dd className="text-right tabular-nums">{money(b.price)}</dd>
        <dt className="text-muted-foreground">{t("breakdown.time")}</dt>
        <dd className="text-right tabular-nums">{plus(b.time_penalty ?? null)}</dd>
        <dt className="text-muted-foreground">{t("breakdown.stops")}</dt>
        <dd className="text-right tabular-nums">{plus(b.stop_penalty)}</dd>
        <dt className="text-muted-foreground">{t("breakdown.risks")}</dt>
        <dd className="text-right tabular-nums">{plus(b.risk_total)}</dd>
        {b.risk_penalties.map((risk, i) => (
          <div key={i} className="contents">
            <dt className="text-muted-foreground pl-3 text-[11px]">
              {t(`risk.${risk.code}`, { airport: risk.airport ?? "—" })}
            </dt>
            <dd className="text-muted-foreground text-right text-[11px] tabular-nums">
              +{money(risk.amount)}
            </dd>
          </div>
        ))}
        <dt className="border-t pt-1 font-medium">{t("breakdown.total")}</dt>
        <dd className="border-t pt-1 text-right font-medium tabular-nums" data-testid="total">
          {b.total != null ? money(b.total) : t("breakdown.unknown")}
        </dd>
      </dl>
      {b.total == null && (
        <p className="text-muted-foreground text-[11px]">{t("breakdown.totalUnknown")}</p>
      )}
      {score.warnings.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {score.warnings.map((w, i) => (
            <li key={i}>
              <Badge
                variant="outline"
                className="border-amber-500/50 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" />
                {t(`warning.${w.code}`, { airport: w.airport ?? "—" })}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
