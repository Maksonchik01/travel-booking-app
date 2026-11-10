import type { Offer, OfferScore, Pick, Reason, ScoringResult } from "@tickets/shared";
import { AlertTriangle, ChevronRight, Scale, Timer, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { InfoHint } from "@/components/info-hint";

import { AirlineLogo, legCarriers } from "@/components/airline-logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useDurationText, WhyList } from "@/components/why-list";
import { splitDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

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
        <InfoHint label={t("how")}>
          <p>{t("formula", { profile: tProfile(scoring.profile) })}</p>
        </InfoHint>
        {scoring.cheapest_basis === "with_baggage" && (
          <p className="text-muted-foreground text-xs" data-testid="cheapest-basis">
            {t("cheapestWithBaggage")}
          </p>
        )}
      </div>
      <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
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
  const recommended = pick.label === "balanced";
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: offer.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const duration =
    offer.total_duration_min != null ? splitDuration(offer.total_duration_min) : null;
  const carriers = legCarriers(offer.outbound, offer);

  return (
    <Card
      className={cn(
        "lift relative h-full gap-3 py-4",
        recommended
          ? "border-primary/50 from-primary/[0.07] to-card bg-gradient-to-b"
          : "hover:border-primary/30",
      )}
      data-testid="top-pick"
      data-label={pick.label}
    >
      <CardHeader className="gap-1 px-4">
        <div className="flex items-center justify-between gap-2">
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
          {carriers.length > 0 && (
            <span className="flex gap-0.5">
              {carriers.map((code) => (
                <AirlineLogo key={code} code={code} url={offer.airline_logos?.[code]} />
              ))}
            </span>
          )}
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
          <span className="text-2xl font-bold tracking-tight tabular-nums">
            {money(offer.price)}
          </span>
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

        {score && (
          <details className="group text-xs">
            <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {tOffer("whyScore")}
            </summary>
            <div className="mt-2">
              <ScoreDetails score={score} money={money} />
            </div>
          </details>
        )}

        <a
          href={`#${offerAnchor(pick.offer_key)}`}
          className="text-primary mt-auto w-fit text-xs font-medium underline-offset-4 hover:underline"
        >
          {t("details")}
        </a>
      </CardContent>
    </Card>
  );
}

/**
 * «Чому цей варіант?» (модуль 14.5): конкретні причини з даних пошуку — що виграв і чим
 * відрізняється від найдешевшого й найшвидшого у грошах, годинах і пересадках. Рахує API.
 */
export function WhyReasons({
  reasons,
  money,
}: {
  reasons: Reason[];
  money: (v: number) => string;
}) {
  const t = useTranslations("picks");
  const duration = useDurationText();
  const text = (r: Reason) => {
    const amount = money(r.amount ?? 0);
    const minutes = duration(r.minutes ?? 0);
    switch (r.code) {
      case "pricier_but_faster":
        return r.amount
          ? t("reason.pricier_but_faster", { amount, duration: minutes })
          : t("reason.same_price_faster", { duration: minutes });
      case "cheaper_but_slower":
        return t("reason.cheaper_but_slower", { amount, duration: minutes });
      case "best_balance":
        return t("reason.best_balance", { total: amount });
      case "avoids_risk":
        return t("reason.avoids_risk", { risk: r.risk ? t(`riskName.${r.risk}`) : "—" });
      case "cheapest":
      case "fastest":
      case "fewer_stops":
        return t(`reason.${r.code}`, { count: r.count ?? 0 });
      default:
        return t(`reason.${r.code}`);
    }
  };
  return <WhyList items={reasons.map(text)} testId="why-reasons" />;
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
    <div className="grid gap-3">
      <WhyReasons reasons={score.reasons ?? []} money={money} />
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs" data-testid="breakdown">
        <dt className="text-muted-foreground">{t("breakdown.price")}</dt>
        <dd className="text-right tabular-nums">{money(b.price)}</dd>
        {b.baggage_extra != null && (
          <>
            <dt className="text-muted-foreground">{t("breakdown.baggage")}</dt>
            <dd className="text-right tabular-nums">{plus(b.baggage_extra)}</dd>
          </>
        )}
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
        {(b.preference_misses ?? []).length > 0 && (
          <>
            <dt className="text-muted-foreground">
              {t("breakdown.preferences")}:{" "}
              {(b.preference_misses ?? []).map((m) => t(`miss.${m}`)).join(", ")}
            </dt>
            <dd className="text-right tabular-nums">{plus(b.preference_penalty ?? 0)}</dd>
          </>
        )}
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
              <Badge variant="outline" className="border-warning/50 text-warning">
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
