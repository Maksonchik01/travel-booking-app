import type {
  CostItem,
  Leg,
  Offer,
  Stay,
  TripCombo,
  TripPickLabel,
  TripReason,
} from "@tickets/shared";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  Briefcase,
  ChevronRight,
  Clock,
  Crown,
  Plane,
  PlaneLanding,
  PlaneTakeoff,
  Receipt,
  Scale,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { AirlineLogo, legCarriers } from "@/components/airline-logo";
import { offerAnchor } from "@/components/top-picks";
import { RatingBadge } from "@/components/stay-card";
import { stayAnchor } from "@/components/stay-picks";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useDurationText, WhyList } from "@/components/why-list";
import { localDate, localTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL_ICON = { cheapest: Wallet, best_value: Scale, comfort: Crown } as const;
const COST_ICON = { tickets: Plane, baggage: Briefcase, stay: BedDouble, extra: Receipt } as const;
const STATUS_CLASS = {
  confirmed: "bg-success/10 text-success",
  approximate: "bg-warning/10 text-warning",
  unknown: "bg-muted text-muted-foreground",
} as const;

type Props = {
  combo: TripCombo;
  offer: Offer;
  stay: Stay;
  /** Підпис складу: «2 дорослі і 1 дитина». */
  travelers: string;
  label?: TripPickLabel;
  also?: TripPickLabel[];
  overBudget?: boolean;
  airlineNames: Record<string, string | null>;
  /** Сторінки перельотів і житла з тими самими параметрами (для деталей). */
  flightsHref: string;
  staysHref: string;
  /** «Обрати й змінити» — зробити цю комбінацію «Вашою поїздкою» (модуль 8b). */
  chooseHref?: string;
  /** «Порівняти» (модуль 8c) — клієнтська кнопка. */
  compare?: React.ReactNode;
};

/**
 * Одна поїздка (модуль 8a): сценарій, сума відомих складових з розбивкою «підтверджено /
 * орієнтовно / невідомо», дати житла від фактичного прильоту й вильоту назад, рейс і житло.
 */
export function TripCard({
  combo,
  offer,
  stay,
  travelers,
  label,
  also = [],
  overBudget = false,
  airlineNames,
  flightsHref,
  staysHref,
  chooseHref,
  compare,
}: Props) {
  const t = useTranslations("tripCard");
  const tPicks = useTranslations("tripPicks");
  const format = useFormatter();
  const money = (value: number, digits = 0) =>
    format.number(value, {
      style: "currency",
      currency: combo.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: digits,
    });
  const Icon = label ? LABEL_ICON[label] : null;
  const recommended = label === "best_value";

  return (
    <Card
      className={cn(
        "lift h-full gap-4 p-4 sm:p-5",
        recommended
          ? "border-primary/50 from-primary/[0.07] to-card bg-gradient-to-b"
          : "hover:border-primary/30",
      )}
      data-testid="trip-card"
      data-label={label}
    >
      {label && Icon && (
        <div className="grid gap-0.5">
          <p className="flex items-center gap-2 font-semibold">
            <span
              className={cn(
                "grid size-7 place-items-center rounded-lg",
                recommended ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            {tPicks(`label.${label}`)}
          </p>
          {also.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {tPicks("also", { labels: format.list(also.map((l) => tPicks(`alsoLabel.${l}`))) })}
            </p>
          )}
        </div>
      )}

      {overBudget && (
        <Badge
          variant="outline"
          className="h-auto w-fit border-warning/50 bg-warning/10 text-left whitespace-normal text-warning"
          data-testid="trip-over-budget"
        >
          <AlertTriangle className="size-3" /> {t("overBudget")}
        </Badge>
      )}

      <div>
        <p className="text-3xl font-bold tracking-tight tabular-nums" data-testid="trip-total">
          {money(combo.money_total)}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("forTrip", { nights: combo.window.nights, travelers })}
        </p>
        {combo.costs.unknown > 0 && (
          <p className="text-xs text-warning">{t("plusUnknown", { count: combo.costs.unknown })}</p>
        )}
      </div>

      <dl
        className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1 text-sm"
        data-testid="trip-breakdown"
      >
        {combo.costs.items.map((item, i) => (
          <CostRow
            key={`${item.kind}-${i}`}
            item={item}
            nights={combo.window.nights}
            money={money}
          />
        ))}
        <dt className="border-t pt-1 text-xs text-success">{t("status.confirmed")}</dt>
        <dd className="col-span-2 border-t pt-1 text-right text-xs tabular-nums">
          {money(combo.costs.confirmed)}
        </dd>
        {combo.costs.approximate > 0 && (
          <>
            <dt className="text-xs text-warning">{t("status.approximate")}</dt>
            <dd className="col-span-2 text-right text-xs tabular-nums">
              {money(combo.costs.approximate)}
            </dd>
          </>
        )}
        <dt className="font-medium">{t("total")}</dt>
        <dd className="col-span-2 text-right font-medium tabular-nums">
          {money(combo.money_total)}
        </dd>
      </dl>

      <dl className="grid gap-1 border-t pt-3 text-xs" data-testid="trip-dates">
        <div className="flex items-start gap-1.5">
          <PlaneLanding className="text-primary mt-px size-3.5 shrink-0" aria-hidden />
          <dt className="sr-only">{t("arrivalLabel")}</dt>
          <dd>
            {combo.arrival_at
              ? t("arrival", {
                  at: `${shortDate(format, localDate(combo.arrival_at))}, ${localTime(combo.arrival_at)}`,
                  date: shortDate(format, combo.window.check_in),
                })
              : t("arrivalUnknown", { date: shortDate(format, combo.window.check_in) })}
          </dd>
        </div>
        <div className="flex items-start gap-1.5">
          <PlaneTakeoff className="text-primary mt-px size-3.5 shrink-0" aria-hidden />
          <dt className="sr-only">{t("returnLabel")}</dt>
          <dd>
            {t("return", {
              at: `${shortDate(format, localDate(combo.return_departure_at))}, ${localTime(combo.return_departure_at)}`,
              date: shortDate(format, combo.window.check_out),
            })}
          </dd>
        </div>
      </dl>

      <TripQuality combo={combo} />

      <div className="grid gap-2 border-t pt-3 text-xs">
        <LegLine leg={offer.outbound} offer={offer} names={airlineNames} label={t("outbound")} />
        {offer.inbound && (
          <LegLine leg={offer.inbound} offer={offer} names={airlineNames} label={t("inbound")} />
        )}
      </div>

      <div className="grid gap-1.5 border-t pt-3 text-xs">
        <p className="text-sm font-semibold">{stay.name}</p>
        <RatingBadge rating={stay.rating ?? null} reviews={stay.review_count ?? 0} />
        <p className="text-muted-foreground">
          {t("stayDates", {
            from: shortDate(format, combo.window.check_in),
            to: shortDate(format, combo.window.check_out),
          })}
          {stay.distance_to_center_km != null &&
            ` · ${t("toCenter", { km: format.number(stay.distance_to_center_km) })}`}
        </p>
      </div>

      {(combo.warnings ?? []).length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {(combo.warnings ?? []).map((w) => (
            <li key={w}>
              <Badge
                variant="outline"
                className="h-auto border-warning/40 bg-warning/5 text-left whitespace-normal text-warning"
              >
                <AlertTriangle className="size-3 shrink-0" /> {t(`warning.${w}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {(combo.reasons ?? []).length > 0 && (
        <details className="group text-xs" data-testid="trip-why">
          <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {t("why")}
          </summary>
          <div className="mt-2 grid gap-2">
            <TripWhyReasons reasons={combo.reasons ?? []} money={money} />
            {combo.value_total != null && (
              <p className="text-muted-foreground text-[11px]">
                {t("value", { value: money(combo.value_total) })}
              </p>
            )}
          </div>
        </details>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {compare}
        {chooseHref && (
          <Link
            href={chooseHref}
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
            data-testid="trip-choose"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            {t("choose")}
          </Link>
        )}
        <TripLink href={`${flightsHref}#${offerAnchor(combo.offer_key)}`} icon={Plane}>
          {t("openFlight")}
        </TripLink>
        <TripLink href={`${staysHref}#${stayAnchor(combo.stay_key)}`} icon={BedDouble}>
          {t("openStay")}
        </TripLink>
      </div>
    </Card>
  );
}

/** Повноцінні ночі й час у дорозі (модуль 14.4) — факти, з яких складається оцінка. */
function TripQuality({ combo }: { combo: TripCombo }) {
  const t = useTranslations("tripCard");
  const duration = useDurationText();
  const parts = [t("nightsFull", { full: combo.full_nights ?? 0, nights: combo.window.nights })];
  if (combo.travel_min != null) {
    parts.push(t("travel", { duration: duration(combo.travel_min) }));
    if (combo.waiting_min) parts.push(t("waiting", { duration: duration(combo.waiting_min) }));
  }
  return (
    <p
      className="text-muted-foreground flex items-start gap-1.5 text-xs"
      data-testid="trip-quality"
    >
      <Clock className="text-primary mt-px size-3.5 shrink-0" aria-hidden />
      {parts.join(" · ")}
    </p>
  );
}

/** «Чому цей варіант?» поїздки: порівняння з «Економом» і «Комфортом», бюджет. Рахує API. */
function TripWhyReasons({
  reasons,
  money,
}: {
  reasons: TripReason[];
  money: (v: number) => string;
}) {
  const t = useTranslations("tripPicks.reason");
  const format = useFormatter();
  const duration = useDurationText();
  const num = (v: number | null | undefined) => format.number(v ?? 0, { maximumFractionDigits: 1 });
  const text = (r: TripReason) => {
    const amount = money(r.amount ?? 0);
    switch (r.code) {
      case "pricier_but_faster":
        return r.amount
          ? t("pricier_but_faster", { amount, duration: duration(r.minutes ?? 0) })
          : t("same_price_faster", { duration: duration(r.minutes ?? 0) });
      case "cheaper_than_comfort":
        return r.minutes
          ? t("cheaper_than_comfort_slower", { amount, duration: duration(r.minutes) })
          : t("cheaper_than_comfort", { amount });
      case "better_rated_stay":
        return t("better_rated_stay", { rating: num(r.rating) });
      case "closer_stay":
        return t("closer_stay", { km: num(r.km) });
      case "within_budget":
      case "over_budget":
        return t(r.code, { amount });
      case "cheapest":
      case "best_value":
      case "comfort":
      case "more_full_nights":
      case "fewer_stops":
        return t(r.code, { count: r.count ?? 0 });
      default:
        return t(r.code);
    }
  };
  return <WhyList items={reasons.map(text)} testId="trip-why-reasons" />;
}

function CostRow({
  item,
  nights,
  money,
}: {
  item: CostItem;
  nights: number;
  money: (value: number) => string;
}) {
  const t = useTranslations("tripCard");
  const Icon = COST_ICON[item.kind];
  const name =
    item.kind === "extra"
      ? (item.label ?? t("cost.extra"))
      : item.kind === "stay"
        ? t("cost.stay", { nights })
        : t(`cost.${item.kind}`);
  return (
    <>
      <dt className="text-muted-foreground flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </dt>
      <dd>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            STATUS_CLASS[item.status],
          )}
          data-testid="trip-cost-status"
        >
          {t(`status.${item.status}`)}
        </span>
      </dd>
      <dd className="text-right tabular-nums">
        {item.amount == null
          ? t("unknownAmount")
          : item.included
            ? t("included")
            : money(item.amount)}
      </dd>
    </>
  );
}

function TripLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: typeof Plane;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

function LegLine({
  leg,
  offer,
  names,
  label,
}: {
  leg: Leg;
  offer: Offer;
  names: Record<string, string | null>;
  label: string;
}) {
  const t = useTranslations("offer");
  const format = useFormatter();
  const carriers = legCarriers(leg, offer);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="flex items-center gap-1.5">
        <span className="text-primary font-semibold uppercase">{label}</span>
        <span className="text-muted-foreground">
          {shortDate(format, localDate(leg.departure_at))}
        </span>
        <span className="font-medium tabular-nums">
          {localTime(leg.departure_at)}
          {leg.arrival_at ? ` → ${localTime(leg.arrival_at)}` : ""}
        </span>
        <span className="text-muted-foreground">
          · {leg.stops === 0 ? t("direct") : t("stops", { count: leg.stops })}
        </span>
      </span>
      {carriers.length > 0 && (
        <span className="flex items-center gap-1">
          {carriers.map((code) => (
            <AirlineLogo key={code} code={code} url={offer.airline_logos?.[code]} size={16} />
          ))}
          <span className="text-muted-foreground max-w-32 truncate">
            {carriers.map((c) => names[c] ?? c).join(" · ")}
          </span>
        </span>
      )}
    </div>
  );
}

function shortDate(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(`${iso}T00:00:00Z`), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
