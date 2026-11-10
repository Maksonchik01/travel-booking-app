"use client";

import type {
  ChatCard,
  FlightChatCard,
  FlightQuery,
  StayChatCard,
  StayQuery,
  TripChatCard,
} from "@tickets/shared";
import { ArrowRight, BedDouble, Clock, Luggage, MapPin, Plane, Star } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { stayAnchor } from "@/components/stay-picks";
import { offerAnchor } from "@/components/top-picks";
import type { StoredCard } from "@/lib/chat-history";
import { hoursAgo, localDate, localTime, splitDuration } from "@/lib/format";
import { toTripParams, toYourTrip } from "@/lib/trip-params";
import { fractionDigits } from "@/lib/money";

/**
 * Посилання карток (модуль 9b): «Переглянути» — сторінка результатів з якорем на варіант;
 * перенесення в планувальник — з тими самими датами, людьми й вибором (рейс чи житло).
 */
export function cardLinks(
  cards: ChatCard[] | undefined,
  pages: { flights?: string; stays?: string },
  queries: { flight?: FlightQuery | null; stay?: StayQuery | null },
): StoredCard[] {
  return (cards ?? []).map((card) => {
    if (card.kind === "trip") {
      // Картка з вибором рейсу й житла — одразу до «Вашої поїздки» (модуль 23b).
      const href = `/trip?${toTripParams(card.query)}`;
      return { card, trip: card.query.flight ? toYourTrip(href) : href };
    }
    if (card.kind === "flight") {
      const q = queries.flight;
      const trip =
        q && card.inbound
          ? `/trip?${new URLSearchParams({
              from: q.origin,
              to: q.destination,
              depart: localDate(card.outbound.departure_at),
              return: localDate(card.inbound.departure_at),
              adults: String(q.passengers?.adults ?? 1),
              ...(q.passengers?.children ? { children: String(q.passengers.children) } : {}),
              flight: card.key,
            })}`
          : undefined;
      return {
        card,
        href: pages.flights ? `${pages.flights}#${offerAnchor(card.key)}` : undefined,
        trip,
      };
    }
    const q = queries.stay;
    const trip = q
      ? `/trip?${new URLSearchParams({
          to: q.city,
          depart: q.check_in,
          return: q.check_out,
          adults: String(q.guests?.adults ?? 2),
          ...(q.guests?.children ? { children: String(q.guests.children) } : {}),
          stay: card.key,
        })}`
      : undefined;
    return { card, href: pages.stays ? `${pages.stays}#${stayAnchor(card.key)}` : undefined, trip };
  });
}

export function ChatCards({ cards, now }: { cards: StoredCard[]; now: Date }) {
  return (
    <ul className="mt-2 grid gap-2 whitespace-normal" data-testid="chat-cards">
      {cards.map((item) => (
        <li key={`${item.card.kind}:${item.card.key}`}>
          {item.card.kind === "flight" ? (
            <FlightCardView card={item.card} item={item} now={now} />
          ) : item.card.kind === "stay" ? (
            <StayCardView card={item.card} item={item} now={now} />
          ) : (
            <TripCardView card={item.card} item={item} now={now} />
          )}
        </li>
      ))}
    </ul>
  );
}

function useMoney() {
  const format = useFormatter();
  return (value: number, currency: string) =>
    format.number(value, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
}

/** Свіжість ціни: жива чи кешована з віком — застарілі дані позначаємо (9.6). */
function PriceAge({
  status,
  foundAt,
  now,
}: {
  status: "live" | "cached";
  foundAt: string | null | undefined;
  now: Date;
}) {
  const t = useTranslations("chatCards");
  const hours = foundAt ? hoursAgo(foundAt, now) : null;
  const stale = status === "cached" && (hours ?? 0) >= 24;
  return (
    <span className={stale ? "text-warning" : "text-muted-foreground"} data-testid="chat-card-age">
      <Clock className="mr-0.5 inline size-3" aria-hidden />
      {status === "live" ? t("live") : t("cached", { hours: hours ?? 0 })}
    </span>
  );
}

function Shell({
  icon: Icon,
  label,
  children,
  actions,
  testId,
}: {
  icon: typeof Plane;
  label?: string | null;
  children: React.ReactNode;
  actions: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="bg-card grid gap-2 rounded-xl border p-3 text-xs shadow-xs"
      data-testid={testId}
    >
      {label && (
        <p className="text-primary flex items-center gap-1.5 font-semibold">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </p>
      )}
      {children}
      <div className="flex flex-wrap gap-1.5">{actions}</div>
    </div>
  );
}

function Action({
  href,
  children,
  track,
}: {
  href: string;
  children: React.ReactNode;
  /** Подія аналітики при переході (модуль 19). */
  track?: "ai_to_planner";
}) {
  return (
    <Link
      href={href}
      data-track={track}
      data-track-source={track ? "chat" : undefined}
      className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-colors"
    >
      {children}
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

function FlightLines({ card }: { card: FlightChatCard }) {
  const t = useTranslations("chatCards");
  const tOffer = useTranslations("offer");
  const format = useFormatter();
  const day = (iso: string) =>
    format.dateTime(new Date(`${localDate(iso)}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const legs = [card.outbound, ...(card.inbound ? [card.inbound] : [])];
  const duration = card.duration_min != null ? splitDuration(card.duration_min) : null;
  return (
    <div className="grid gap-0.5">
      {legs.map((leg) => (
        <p key={leg.departure_at} className="tabular-nums">
          <span className="font-medium">
            {leg.origin} → {leg.destination}
          </span>{" "}
          · {day(leg.departure_at)} {localTime(leg.departure_at)}
          {leg.arrival_at ? `–${localTime(leg.arrival_at)}` : ""} ·{" "}
          {leg.stops === 0 ? tOffer("direct") : tOffer("stops", { count: leg.stops })}
        </p>
      ))}
      <p className="text-muted-foreground">
        {card.airlines.join(", ") || t("airlineUnknown")}
        {duration &&
          ` · ${tOffer("duration", { hours: duration.hours, minutes: String(duration.minutes).padStart(2, "0") })}`}
      </p>
    </div>
  );
}

function FlightCardView({
  card,
  item,
  now,
}: {
  card: FlightChatCard;
  item: StoredCard;
  now: Date;
}) {
  const t = useTranslations("chatCards");
  const money = useMoney();
  return (
    <Shell
      icon={Plane}
      label={card.label}
      testId="chat-card-flight"
      actions={
        <>
          {item.href && <Action href={item.href}>{t("view")}</Action>}
          {item.trip && <Action href={item.trip}>{t("planWithFlight")}</Action>}
        </>
      }
    >
      <FlightLines card={card} />
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-bold tabular-nums">{money(card.price, card.currency)}</span>
        <span className="text-muted-foreground">{t("forAll")}</span>
        <PriceAge status={card.price_status} foundAt={card.found_at} now={now} />
      </p>
    </Shell>
  );
}

function StayLines({ card }: { card: StayChatCard }) {
  const t = useTranslations("chatCards");
  const tStay = useTranslations("stayCard");
  const format = useFormatter();
  return (
    <div className="flex gap-2.5">
      {card.image_url ? (
        // Фото від джерела (https), хостів наперед не знаємо.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.image_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-14 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="from-primary/15 text-primary/70 grid size-14 shrink-0 place-items-center rounded-lg bg-gradient-to-br to-sky-400/10"
        >
          <BedDouble className="size-6" />
        </span>
      )}
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate text-sm font-semibold">{card.name}</p>
        <p className="text-muted-foreground">
          {tStay(`kind.${card.stay_kind}`)}
          {card.rating != null && (
            <>
              {" · "}
              <Star className="inline size-3 fill-amber-400 text-amber-400" aria-hidden />{" "}
              {format.number(card.rating, { maximumFractionDigits: 1 })} (
              {tStay("reviews", { count: card.review_count })})
            </>
          )}
        </p>
        <p className="text-muted-foreground">
          <MapPin className="inline size-3" aria-hidden />{" "}
          {[
            card.district,
            card.distance_to_center_km != null
              ? t("km", { km: format.number(card.distance_to_center_km) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || t("locationUnknown")}
        </p>
      </div>
    </div>
  );
}

function StayCardView({ card, item, now }: { card: StayChatCard; item: StoredCard; now: Date }) {
  const t = useTranslations("chatCards");
  const money = useMoney();
  return (
    <Shell
      icon={BedDouble}
      label={card.label}
      testId="chat-card-stay"
      actions={
        <>
          {item.href && <Action href={item.href}>{t("view")}</Action>}
          {item.trip && <Action href={item.trip}>{t("addToTrip")}</Action>}
        </>
      }
    >
      <StayLines card={card} />
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-bold tabular-nums">
          {money(card.price_per_night, card.currency)}
        </span>
        <span className="text-muted-foreground">
          {t("perNight", { total: money(card.total_price, card.currency), nights: card.nights })}
        </span>
        <PriceAge status="cached" foundAt={card.found_at} now={now} />
      </p>
    </Shell>
  );
}

function TripCardView({ card, item, now }: { card: TripChatCard; item: StoredCard; now: Date }) {
  const t = useTranslations("chatCards");
  const money = useMoney();
  return (
    <Shell
      icon={Luggage}
      label={card.label}
      testId="chat-card-trip"
      actions={
        item.trip && (
          <Action href={item.trip} track="ai_to_planner">
            {t("openInPlanner")}
          </Action>
        )
      }
    >
      <FlightLines card={card.flight} />
      <StayLines card={card.stay} />
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-bold tabular-nums" data-testid="chat-card-total">
          {money(card.money_total, card.currency)}
        </span>
        <span className="text-muted-foreground">{t("tripTotal", { nights: card.nights })}</span>
        {card.unknown_parts > 0 && (
          <span className="text-warning">{t("unknownParts", { count: card.unknown_parts })}</span>
        )}
        <PriceAge
          status={card.prices_cached ? "cached" : "live"}
          foundAt={card.flight.found_at}
          now={now}
        />
      </p>
    </Shell>
  );
}
