import type {
  BagAllowance,
  Baggage,
  BaggageCost,
  BaggageNeed,
  Leg,
  Offer,
  OfferScore,
  PickLabel,
} from "@tickets/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  Briefcase,
  ChevronRight,
  Clock,
  Moon,
  Plane,
  Store,
  Ticket,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { AirlineLogo, legCarriers } from "@/components/airline-logo";
import { ScoreDetails } from "@/components/top-picks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { dayShift, daysAgo, hoursAgo, localDate, localTime, splitDuration } from "@/lib/format";
import { outboundHref } from "@/lib/outbound";
import { layoverRisks, type LayoverRisk } from "@/lib/risks";
import { cn } from "@/lib/utils";

const RISK_ICON: Record<LayoverRisk, typeof Clock> = {
  short: AlertTriangle,
  long: Clock,
  overnight: Moon,
  selfTransfer: Ticket,
};

const KNOWN_SOURCES = new Set(["serpapi", "travelpayouts", "mock"]);

export function OfferCard({
  offer,
  now,
  pickLabel,
  score,
  airlineNames,
  travellers = 1,
  baggageCost,
  baggageNeed = "none",
  sellers,
  pickAlso = [],
  sellerCount = 1,
  compare,
}: {
  offer: Offer;
  now: Date;
  /** Вартість з багажем, який обрав користувач (рахує API, ADR 0014); немає — багаж не потрібен. */
  baggageCost?: BaggageCost;
  /** Багаж, який обрав користувач: картка показує умови саме цих місць. */
  baggageNeed?: BaggageNeed;
  /** Блок «Пропозиції продавців» (клієнтський компонент) — під основним вмістом. */
  sellers?: React.ReactNode;
  /** Інші позначки «Нашого вибору» тієї ж пропозиції (напр. ще й найшвидша). */
  pickAlso?: PickLabel[];
  /** Скільки продавців (джерел) у цього рейсу — з групування (модуль 3). */
  sellerCount?: number;
  /** Перемикач «Порівняти» (клієнтський) — у колонці ціни. */
  compare?: React.ReactNode;
  /** Скільки пасажирів у ціні (вона за весь склад запиту, ADR 0013). */
  travellers?: number;
  pickLabel?: PickLabel;
  score?: OfferScore;
  /** IATA-код → назва (з фасетів пошуку); невідомі показуємо кодом. */
  airlineNames?: Record<string, string | null>;
}) {
  const t = useTranslations("offer");
  const tPicks = useTranslations("picks");
  const tResults = useTranslations("results");
  const format = useFormatter();
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: offer.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    });

  // Точність віку ціни — така, яку дає джерело: години, лише день або невідомо.
  const age = offer.found_at
    ? t("foundAgo", { hours: hoursAgo(offer.found_at, now) })
    : offer.found_on
      ? t("foundOnAgo", { days: daysAgo(offer.found_on, now) })
      : t("collectedAgo", { hours: hoursAgo(offer.collected_at, now) });
  const service = KNOWN_SOURCES.has(offer.source)
    ? tResults(`provider.${offer.source as "serpapi" | "travelpayouts" | "mock"}`)
    : offer.source;

  return (
    <Card
      className={cn(
        "lift group/card gap-0 overflow-hidden py-0 sm:grid sm:grid-cols-[1fr_13rem]",
        "hover:border-primary/40 focus-within:border-primary/50",
        pickLabel && "border-primary/30",
      )}
      data-testid="offer-card"
    >
      <div className="grid content-start gap-4 p-4 sm:p-5">
        <LegRow label={t("outbound")} leg={offer.outbound} offer={offer} names={airlineNames} />
        {offer.inbound && (
          <>
            <div className="border-t border-dashed" />
            <LegRow label={t("inbound")} leg={offer.inbound} offer={offer} names={airlineNames} />
          </>
        )}
        <RouteDetails offer={offer} names={airlineNames} />
        {score && (
          <details className="group text-xs" data-testid="score-details">
            <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {t("whyScore")}{" "}
              <span className="text-foreground font-medium tabular-nums">
                {score.breakdown.total != null
                  ? money(score.breakdown.total)
                  : tPicks("breakdown.unknown")}
              </span>
            </summary>
            <div className="bg-muted/50 mt-2 max-w-sm rounded-lg p-3">
              <ScoreDetails score={score} money={money} />
            </div>
          </details>
        )}
      </div>

      {/* На мобільному ціна й кнопка — нагорі картки: це те, що порівнюють першим. */}
      <aside className="bg-muted/40 order-first flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b p-4 sm:order-none sm:flex-col sm:flex-nowrap sm:items-stretch sm:justify-start sm:border-b-0 sm:border-l sm:p-5">
        <div>
          <OfferBadges offer={offer} pickLabel={pickLabel} pickAlso={pickAlso} />
          <p
            className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl"
            data-testid="price"
          >
            {format.number(offer.price, {
              style: "currency",
              currencyDisplay: "narrowSymbol",
              currency: offer.currency,
              maximumFractionDigits: 0,
            })}
          </p>
          <p className="text-muted-foreground text-xs">
            {travellers > 1 ? t("forPassengers", { count: travellers }) : t("perAdult")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs" data-testid="price-age">
            {age}
          </p>
          {offer.total_duration_min != null && (
            <p
              className="text-muted-foreground mt-1 flex items-center gap-1 text-xs"
              data-testid="total-duration"
            >
              <Clock className="size-3" aria-hidden />
              {t("totalDuration", { duration: duration(t, offer.total_duration_min) })}
            </p>
          )}
        </div>

        <div className="grid w-full gap-2 text-xs sm:w-auto">
          {baggageNeed !== "none" ? (
            <BaggageDetails baggage={offer.baggage} need={baggageNeed} money={money} />
          ) : (
            <BaggageNote included={offer.baggage_included ?? null} />
          )}
          {baggageCost && <BaggageTotal cost={baggageCost} money={money} />}
          <p className="text-muted-foreground flex items-start gap-1.5" data-testid="seller">
            <Store className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {sellerCount > 1
                ? `${t("sellerCount", { count: sellerCount })} · `
                : offer.seller
                  ? `${t("seller", { seller: offer.seller })} · `
                  : null}
              {t("via", { service })}
            </span>
          </p>
          {offer.deep_link && (
            <Button asChild className="w-full transition-transform active:scale-[0.98] sm:mt-1">
              <a
                href={outboundHref(offer.deep_link, "flight", offer.source)}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {isGoogleFlights(offer.deep_link) ? t("openGoogleFlights") : t("book")}
                <ArrowUpRight className="size-4" aria-hidden />
              </a>
            </Button>
          )}
          {offer.deep_link && (
            <p className="text-muted-foreground max-w-56 text-[11px] leading-snug">
              {t("partnerNote")}
            </p>
          )}
          {compare}
        </div>
      </aside>
      {/* Продавці (модуль 3) — на всю ширину картки. */}
      {sellers && <div className="sm:col-span-2">{sellers}</div>}
    </Card>
  );
}

function isGoogleFlights(url: string): boolean {
  return url.startsWith("https://www.google.com/travel/flights");
}

function LegRow({
  label,
  leg,
  offer,
  names,
}: {
  label: string;
  leg: Leg;
  offer: Offer;
  names?: Record<string, string | null>;
}) {
  const t = useTranslations("offer");
  const format = useFormatter();
  const shift = leg.arrival_at ? dayShift(leg.departure_at, leg.arrival_at) : 0;
  const carriers = legCarriers(leg, offer);
  const date = format.dateTime(new Date(`${localDate(leg.departure_at)}T00:00:00Z`), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          <span className="text-primary font-semibold tracking-wide uppercase">{label}</span>
          {" · "}
          {date}
        </span>
        {carriers.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5" data-testid="airlines">
            <span className="flex gap-0.5">
              {carriers.map((code) => (
                <AirlineLogo key={code} code={code} url={offer.airline_logos?.[code]} />
              ))}
            </span>
            <span className="truncate font-medium">
              {carriers.map((code) => names?.[code] ?? code).join(" · ")}
            </span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <Endpoint time={localTime(leg.departure_at)} airport={leg.origin} />
        <div className="flex flex-col items-center gap-1">
          <span className="text-muted-foreground text-[11px]">
            {leg.duration_min != null ? duration(t, leg.duration_min) : t("durationUnknown")}
          </span>
          <div className="relative flex w-full items-center" aria-hidden>
            <span className="bg-primary/60 size-1.5 rounded-full" />
            <span className="bg-primary/25 h-px flex-1" />
            {Array.from({ length: leg.stops }, (_, i) => (
              <span key={i} className="contents">
                <span className="border-primary bg-card size-2 rounded-full border-2" />
                <span className="bg-primary/25 h-px flex-1" />
              </span>
            ))}
            <Plane className="text-primary size-3.5" />
          </div>
          <span
            className={cn(
              "text-xs",
              leg.stops === 0
                ? "font-medium text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            {leg.stops === 0 ? t("direct") : t("stops", { count: leg.stops })}
          </span>
        </div>
        {/* Час прильоту не вигадуємо: без поясу аеропорту прильоту його не порахувати. */}
        <Endpoint
          time={leg.arrival_at ? localTime(leg.arrival_at) : null}
          airport={leg.destination}
          shift={shift}
          align="end"
        />
      </div>

      <Layovers leg={leg} />
    </div>
  );
}

function Endpoint({
  time,
  airport,
  shift = 0,
  align = "start",
}: {
  time: string | null;
  airport: string;
  shift?: number;
  align?: "start" | "end";
}) {
  return (
    <div className={align === "end" ? "text-right" : undefined}>
      {time ? (
        <>
          <p className="text-xl font-semibold tracking-tight tabular-nums">
            {time}
            {shift > 0 && (
              <sup className="ml-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                +{shift}
              </sup>
            )}
          </p>
          <p className="text-muted-foreground text-xs font-medium">{airport}</p>
        </>
      ) : (
        <p className="text-xl font-semibold">{airport}</p>
      )}
    </div>
  );
}

function Layovers({ leg }: { leg: Leg }) {
  const t = useTranslations("offer");
  if (leg.stops === 0) return null;

  if (leg.layovers == null) {
    return (
      <Badge
        variant="outline"
        className="w-fit border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="size-3" /> {t("detailsUnknown")}
      </Badge>
    );
  }

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {leg.layovers.map((layover, i) => {
        const risks = layoverRisks(layover);
        return (
          <li key={i} className="flex flex-wrap items-center gap-1.5" data-testid="layover">
            <span className="text-muted-foreground">
              {t("layoverIn", {
                airport: layover.airport,
                duration: duration(t, layover.duration_min),
              })}
            </span>
            {risks.map((risk) => {
              const Icon = RISK_ICON[risk];
              return (
                <Badge
                  key={risk}
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                >
                  <Icon className="size-3" /> {t(`risk.${risk}`)}
                </Badge>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

/** Які місця багажу потрібні для вибору користувача (як BAGS_FOR_NEED в API). */
const BAGS_FOR_NEED: Record<BaggageNeed, (keyof Baggage)[]> = {
  none: [],
  personal_item: ["personal_item"],
  carry_on: ["personal_item", "carry_on"],
  checked: ["personal_item", "checked"],
  checked_extra: ["personal_item", "checked", "checked_extra"],
};

/** Умови саме тих місць багажу, що обрав користувач: у тарифі / за плату / недоступно / невідомо. */
function BaggageDetails({
  baggage,
  need,
  money,
}: {
  baggage: Baggage | null | undefined;
  need: BaggageNeed;
  money: (value: number) => string;
}) {
  const t = useTranslations("offer");
  const status = (a: BagAllowance | null | undefined) =>
    !a
      ? t("bag.unknown")
      : a.status === "included"
        ? t("bag.included")
        : a.status === "not_available"
          ? t("bag.notAvailable")
          : a.fee != null
            ? t("bag.fee", { fee: money(a.fee) })
            : t("bag.feeUnknown");
  return (
    <ul className="text-muted-foreground grid gap-0.5" data-testid="baggage">
      {BAGS_FOR_NEED[need].map((row) => (
        <li
          key={row}
          className={cn(
            "flex items-start gap-1.5",
            baggage?.[row]?.status === "included" && "text-emerald-700 dark:text-emerald-400",
          )}
        >
          <Briefcase className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            {t(`bag.${row}`)}: {status(baggage?.[row])}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Кінцева вартість з потрібним багажем — або чесне «невідомо» (не «безкоштовно»). */
function BaggageTotal({ cost, money }: { cost: BaggageCost; money: (value: number) => string }) {
  const t = useTranslations("offer");
  if (cost.status === "included" || cost.status === "extra") {
    return (
      <p className="font-medium" data-testid="baggage-total">
        {cost.status === "included"
          ? t("withBaggageIncluded")
          : t("withBaggage", { total: money(cost.total ?? 0) })}
      </p>
    );
  }
  return (
    <p
      className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
      data-testid="baggage-total"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      {cost.status === "not_available" ? t("baggageNotAvailable") : t("baggageCostUnknown")}
    </p>
  );
}

function BaggageNote({ included }: { included: boolean | null }) {
  const t = useTranslations("offer");
  const text =
    included === true
      ? t("baggageIncluded")
      : included === false
        ? t("baggageNotIncluded")
        : t("baggageUnknown");
  return (
    <p
      className={cn(
        "flex items-center gap-1.5",
        included === true ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      <Briefcase className="size-3.5" aria-hidden /> {text}
    </p>
  );
}

function duration(t: ReturnType<typeof useTranslations<"offer">>, minutes: number) {
  const { hours, minutes: mins } = splitDuration(minutes);
  if (hours === 0) return t("durationShort", { minutes: mins });
  return t("duration", { hours, minutes: String(mins).padStart(2, "0") });
}

/**
 * Позначки картки — лише з реальних параметрів: вибір скорингу (найдешевший/найшвидший/
 * оптимальний), «Прямий рейс» (без пересадок в обидва боки), «Самостійна пересадка»
 * (джерело позначило окремі квитки хоч на одній пересадці).
 */
function OfferBadges({
  offer,
  pickLabel,
  pickAlso,
}: {
  offer: Offer;
  pickLabel?: PickLabel;
  pickAlso: PickLabel[];
}) {
  const t = useTranslations("offer");
  const legs = [offer.outbound, ...(offer.inbound ? [offer.inbound] : [])];
  const direct = legs.every((leg) => leg.stops === 0);
  const selfTransfer = legs.some((leg) => leg.layovers?.some((l) => l.self_transfer === true));
  const labels = [...(pickLabel ? [pickLabel] : []), ...pickAlso];
  if (labels.length === 0 && !direct && !selfTransfer) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1" data-testid="offer-badges">
      {labels.map((label, i) => (
        <Badge
          key={label}
          variant={i === 0 ? "default" : "secondary"}
          data-testid={i === 0 ? "pick-label" : undefined}
        >
          {t(`badge.${label}`)}
        </Badge>
      ))}
      {direct && (
        <Badge
          variant="outline"
          className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
        >
          {t("badge.direct")}
        </Badge>
      )}
      {selfTransfer && (
        <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
          {t("badge.selfTransfer")}
        </Badge>
      )}
    </div>
  );
}

/**
 * Деталі маршруту (4.1): кожен сегмент з точним місцевим часом і датою, очікування між рейсами,
 * зміна аеропорту, повторна реєстрація багажу (якщо відомо) і ризики. Без посегментних даних —
 * чесно «джерело не дає».
 */
function RouteDetails({ offer, names }: { offer: Offer; names?: Record<string, string | null> }) {
  const t = useTranslations("offer");
  const format = useFormatter();
  const legs: [string, Leg][] = [
    [t("outbound"), offer.outbound],
    ...(offer.inbound ? [[t("inbound"), offer.inbound] as [string, Leg]] : []),
  ];
  const when = (iso: string) =>
    `${localTime(iso)} · ${format.dateTime(new Date(`${localDate(iso)}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })}`;
  return (
    <details className="group text-xs" data-testid="route-details">
      <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {t("routeDetails")}
      </summary>
      <div className="bg-muted/50 mt-2 grid gap-3 rounded-lg p-3">
        {legs.map(([label, leg]) => (
          <div key={label} className="grid gap-1.5">
            <p className="text-primary font-semibold tracking-wide uppercase">{label}</p>
            {leg.segments?.length ? (
              <ol className="grid gap-1.5">
                {leg.segments.map((seg, i) => {
                  const next = leg.segments?.[i + 1];
                  const layover = leg.layovers?.[i];
                  const airportChange = next && next.origin !== seg.destination;
                  return (
                    <li key={`${seg.flight_number}-${i}`} className="grid gap-1.5">
                      <div
                        className="grid gap-0.5 rounded-md border bg-card px-2.5 py-2"
                        data-testid="segment"
                      >
                        <p className="font-medium">
                          {seg.flight_number} · {names?.[seg.carrier] ?? seg.carrier}
                          <span className="text-muted-foreground font-normal">
                            {" · "}
                            {duration(t, seg.duration_min)}
                          </span>
                        </p>
                        <p className="tabular-nums">
                          {seg.origin} {when(seg.departure_at)} → {seg.destination}{" "}
                          {when(seg.arrival_at)}
                        </p>
                      </div>
                      {next && (
                        <div
                          className="text-muted-foreground grid gap-0.5 pl-2.5"
                          data-testid="connection"
                        >
                          <p>
                            {t("connectionWait", {
                              airport: seg.destination,
                              duration: layover
                                ? duration(t, layover.duration_min)
                                : t("durationUnknown"),
                            })}
                          </p>
                          {airportChange && (
                            <p className="font-medium text-amber-700 dark:text-amber-400">
                              {t("airportChange", { from: seg.destination, to: next.origin })}
                            </p>
                          )}
                          <p>
                            {layover?.self_transfer === true
                              ? t("recheckYes")
                              : layover?.self_transfer === false
                                ? t("recheckNo")
                                : t("recheckUnknown")}
                          </p>
                          {layover && layoverRisks(layover).length > 0 && (
                            <p className="text-amber-700 dark:text-amber-400">
                              {layoverRisks(layover)
                                .map((risk) => t(`risk.${risk}`))
                                .join(" · ")}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-muted-foreground">{t("noSegments")}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
