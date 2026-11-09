import type { Offer, Stay, TripCombo, TripQuery, TripSearchResult } from "@tickets/shared";
import { BedDouble, Plane, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { FavoriteToggle } from "@/components/favorites";
import { OptimizeWithAI } from "@/components/open-chat-button";
import { SaveTripButton, ShareTripButton } from "@/components/saved-trips";
import { TripCard } from "@/components/trip-card";
import { TripCompareToggle } from "@/components/trip-compare";
import { TripCheaper } from "@/components/trip-cheaper";
import { TripUndo } from "@/components/trip-history";
import { Button } from "@/components/ui/button";
import { localTime } from "@/lib/format";
import { pinnedQuery, tripSnapshot } from "@/lib/saved-trips";
import { toTripParams, withChoice } from "@/lib/trip-params";
import { cn } from "@/lib/utils";

/**
 * «Ваша поїздка» (модуль 8b): обраний рейс і житло з бюджетом, заміна кожного компонента
 * (інший лишається, якщо сумісний — це перевіряє сервер), «Знайти дешевший варіант»,
 * «Повернути попередній вибір» і «Скинути вибір». Стан — у URL (`flight=`, `stay=`).
 */
export function TripBuilder({
  data,
  query,
  selected,
  travelers,
  airlineNames,
  flightsHref,
  staysHref,
  saved,
  title,
  pricedAt,
  aiEnabled = false,
}: {
  data: TripSearchResult;
  query: TripQuery;
  selected: TripCombo;
  travelers: string;
  airlineNames: Record<string, string | null>;
  flightsHref: string;
  staysHref: string;
  /** Id збереженої поїздки, яку редагують (`saved=`). */
  saved?: string | null;
  /** Назва для збереження: «WAW → LIS · 5–8 груд.». */
  title: string;
  /** Час рендеру (ISO) — коли отримано ціни знімка. */
  pricedAt: string;
  /** ШІ увімкнено — кнопка «Оптимізувати з ШІ». */
  aiEnabled?: boolean;
}) {
  const t = useTranslations("tripBuilder");
  const format = useFormatter();
  const offers = new Map(data.offers.map((o) => [`${o.source}:${o.id}`, o]));
  const offer = offers.get(selected.offer_key)!;
  const stay = data.stays[selected.stay_index];
  const pinned = pinnedQuery(query, selected);
  const snapshot = tripSnapshot(selected, offer, stay, pricedAt);
  const here = withChoice(query, {}, saved);
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: selected.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const diff = (value: number) =>
    value === 0 ? t("same") : `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`;
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const overBudget = query.budget_total != null && selected.money_total > query.budget_total;
  const flightOptions = (data.flight_options ?? []).filter(
    (f) => f.offer_key !== selected.offer_key && f.window,
  );
  const stayOptions = (data.stay_options ?? [])
    .map((i) => ({ index: i, stay: data.stays[i] }))
    .filter(({ stay }) => `${stay.source}:${stay.id}` !== selected.stay_key);
  const notices = [
    data.pinned_flight === "unavailable" ? t("flightUnavailable") : null,
    query.flight && data.pinned_flight === "used" && data.pinned_stay === "unavailable"
      ? t("stayReplaced")
      : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="grid gap-3" aria-labelledby="trip-builder-title" data-testid="trip-builder">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id="trip-builder-title" className="text-xl font-semibold tracking-tight">
            {t("title")}
          </h2>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <TripUndo params={here.split("?")[1]} showButton />
          <Button asChild variant="ghost" size="sm">
            <Link
              href={withChoice(query, { flight: null, stay: null }, saved)}
              data-testid="trip-reset"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {t("reset")}
            </Link>
          </Button>
        </div>
      </div>

      {notices.map((text) => (
        <p
          key={text}
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
          role="status"
          data-testid="trip-builder-notice"
        >
          {text}
        </p>
      ))}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        <TripCard
          combo={selected}
          offer={offer}
          stay={stay}
          travelers={travelers}
          overBudget={overBudget}
          airlineNames={airlineNames}
          flightsHref={flightsHref}
          staysHref={staysHref}
          compare={
            <>
              <TripCompareToggle item={{ key: selected.key, title: t("title"), snapshot }} />
              <FavoriteToggle body={{ kind: "trip", trip: { title, query: pinned, snapshot } }} />
            </>
          }
        />

        <div className="grid gap-4">
          <div className="bg-card grid gap-2 rounded-xl border p-4" data-testid="trip-save-panel">
            <div className="flex flex-wrap items-center gap-2">
              {/* key: інша конфігурація — свіжа кнопка (стан «Збережено» не переноситься). */}
              <SaveTripButton
                key={here}
                body={{ title, query: pinned, snapshot, status: "draft" }}
                savedId={saved}
              />
              <ShareTripButton key={`share-${here}`} href={`/trip?${toTripParams(pinned)}`} />
              {aiEnabled && <OptimizeWithAI />}
            </div>
            <p className="text-muted-foreground text-[11px]">{t("saveHint")}</p>
          </div>
          <div className="bg-card grid gap-2 rounded-xl border p-4">
            <TripCheaper query={query} />
            <p className="text-muted-foreground text-[11px]">{t("cheaperHint")}</p>
          </div>

          <Options
            title={t("replaceFlight")}
            hint={t("replaceFlightHint")}
            icon={Plane}
            empty={t("noFlights")}
            testId="trip-flight-options"
          >
            {flightOptions.map((option) => {
              const offer = offers.get(option.offer_key);
              if (!offer || !option.window) return null;
              return (
                <OptionRow
                  key={option.offer_key}
                  href={withChoice(
                    query,
                    { flight: option.offer_key, stay: query.stay ?? selected.stay_key },
                    saved,
                  )}
                  title={`${day(option.window.check_in)} – ${day(option.window.check_out)} · ${t("nights", { count: option.window.nights })}`}
                  detail={flightDetail(offer, airlineNames, t)}
                  price={money(option.flight_total)}
                  delta={diff(option.flight_total - selected.flight_total)}
                  cheaper={option.flight_total < selected.flight_total}
                  note={option.baggage_unknown ? t("baggageUnknown") : undefined}
                />
              );
            })}
          </Options>

          <Options
            title={t("replaceStay", { nights: selected.window.nights })}
            hint={t("replaceStayHint")}
            icon={BedDouble}
            empty={t("noStays")}
            testId="trip-stay-options"
          >
            {stayOptions.map(({ index, stay }) => (
              <OptionRow
                key={index}
                href={withChoice(
                  query,
                  { flight: selected.offer_key, stay: `${stay.source}:${stay.id}` },
                  saved,
                )}
                title={stay.name}
                detail={stayDetail(stay, format, t)}
                price={money(stay.total_price)}
                delta={diff(stay.total_price - selected.stay_total)}
                cheaper={stay.total_price < selected.stay_total}
              />
            ))}
          </Options>
        </div>
      </div>
    </section>
  );
}

type T = ReturnType<typeof useTranslations<"tripBuilder">>;

function flightDetail(offer: Offer, names: Record<string, string | null>, t: T): string {
  const leg = (l: Offer["outbound"]) =>
    `${localTime(l.departure_at)}${l.arrival_at ? `–${localTime(l.arrival_at)}` : ""}`;
  return [
    `${offer.outbound.origin} ${leg(offer.outbound)}`,
    offer.inbound ? `${offer.inbound.origin} ${leg(offer.inbound)}` : null,
    offer.stops === 0 ? t("direct") : t("stops", { count: offer.stops ?? 0 }),
    offer.airlines.map((c) => names[c] ?? c).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
}

function stayDetail(stay: Stay, format: ReturnType<typeof useFormatter>, t: T): string {
  return [
    stay.rating != null ? `★ ${format.number(stay.rating, { maximumFractionDigits: 1 })}` : null,
    stay.distance_to_center_km != null
      ? t("km", { km: format.number(stay.distance_to_center_km) })
      : null,
    stay.district,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Options({
  title,
  hint,
  icon: Icon,
  empty,
  testId,
  children,
}: {
  title: string;
  hint: string;
  icon: typeof Plane;
  empty: string;
  testId: string;
  children: React.ReactNode[];
}) {
  const rows = children.filter(Boolean);
  return (
    <details className="bg-card group rounded-xl border p-4" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold select-none">
        <Icon className="text-primary size-4" aria-hidden />
        {title}
        <span className="text-muted-foreground ml-auto text-xs font-normal">{rows.length}</span>
      </summary>
      <p className="text-muted-foreground mt-2 text-xs">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">{empty}</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">{rows}</ul>
      )}
    </details>
  );
}

function OptionRow({
  href,
  title,
  detail,
  price,
  delta,
  cheaper,
  note,
}: {
  href: string;
  title: string;
  detail: string;
  price: string;
  delta: string;
  cheaper: boolean;
  note?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        className="hover:border-primary/50 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border px-3 py-2 text-sm transition-colors"
        data-testid="trip-option"
      >
        <span className="grid min-w-0">
          <span className="truncate font-medium">{title}</span>
          <span className="text-muted-foreground truncate text-xs">{detail}</span>
          {note && <span className="text-xs text-warning">{note}</span>}
        </span>
        <span className="grid text-right">
          <span className="font-semibold tabular-nums">{price}</span>
          <span
            className={cn(
              "text-xs tabular-nums",
              cheaper ? "text-success" : "text-muted-foreground",
            )}
          >
            {delta}
          </span>
        </span>
      </Link>
    </li>
  );
}
