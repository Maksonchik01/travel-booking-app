"use client";

import type { RateOffer, RoomOffers, StayQuery, StayRatesResult } from "@tickets/shared";
import { ArrowUpRight, BadgeCheck, Loader2, Store } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { RetryNotice } from "@/components/retry";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { outboundHref } from "@/lib/outbound";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

export type RatesCheck =
  { state: "idle" } | { state: "loading" } | { state: "done"; result: StayRatesResult };

export async function requestStayRates(
  query: StayQuery,
  source: string,
  stayId: string,
): Promise<StayRatesResult> {
  try {
    const response = await fetchWithTimeout("/api/stays/rates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, source, stay_id: stayId }),
    });
    return (await response.json()) as StayRatesResult;
  } catch {
    return { status: "error", rooms: [], sellers: 0 };
  }
}

/**
 * Тарифи продавців (модуль 7): групи однакових умов — номер, ліжко, харчування, скасування;
 * дати й гості для всіх однакові (той самий запит). Кінцева сума — лише коли відомі податки
 * й збори; «найдешевший» — серед таких. Різні номери не зливаємо.
 */
export function StayRates({
  check,
  now,
  source,
  onRetry,
}: {
  check: RatesCheck;
  now: Date;
  /** Помилка джерела — повторити перевірку (модуль 13.2). */
  onRetry?: () => void;
  /** Джерело об'єкта — для обліку переходу (`/out`). */
  source: string;
}) {
  const t = useTranslations("stayRates");
  if (check.state === "idle") return null;
  if (check.state === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("checking")}
      </p>
    );
  }
  const result = check.result;
  if (result.status !== "ok" || !result.rooms?.length) {
    const key =
      result.status === "rate_limited"
        ? "rateLimited"
        : result.status === "error"
          ? "failed"
          : "unsupported";
    if (key === "failed") return <RetryNotice message={t(key)} onRetry={onRetry} />;
    return (
      <p className="text-muted-foreground text-xs" role="status" data-testid="stay-rates-status">
        {t(key)}
      </p>
    );
  }
  const minutes = result.checked_at
    ? Math.max(0, Math.round((now.getTime() - Date.parse(result.checked_at)) / 60_000))
    : null;
  return (
    <div className="grid gap-3" data-testid="stay-rates">
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
        <BadgeCheck className="size-3.5 text-success" aria-hidden />
        {minutes != null && minutes > 1 ? t("checkedMinutes", { minutes }) : t("checkedNow")}
        <span>· {t("sameConditions", { nights: result.nights ?? 0 })}</span>
      </p>
      {(result.sellers ?? 0) < 2 && (
        <p className="text-muted-foreground text-xs">{t("oneSeller")}</p>
      )}
      {result.rooms.map((room) => (
        <RoomGroup key={room.key} room={room} source={source} />
      ))}
      <p className="text-muted-foreground text-[11px] leading-snug">{t("note")}</p>
    </div>
  );
}

function RoomGroup({ room, source }: { room: RoomOffers; source: string }) {
  const t = useTranslations("stayRates");
  const conditions = [
    room.bed_type ? t(`bed.${room.bed_type}`) : t("bedUnknown"),
    room.meal ? t(`meal.${room.meal}`) : t("mealUnknown"),
    t(`cancellation.${room.cancellation ?? "unknown"}`),
  ];
  return (
    <section className="grid gap-1.5" data-testid="stay-room">
      <h4 className="text-sm font-semibold">
        {/* Джерело не назвало номер (Google Hotels) — чесно: тип номера уточнює продавець. */}
        {room.room_name || t("roomAny")}
        <span className="text-muted-foreground ml-2 text-xs font-normal">
          {conditions.join(" · ")}
        </span>
      </h4>
      <ul className="grid gap-1.5">
        {room.offers.map((offer) => (
          <RateRow
            key={`${offer.rate.seller}|${offer.rate.price_total}`}
            offer={offer}
            source={source}
          />
        ))}
      </ul>
    </section>
  );
}

function RateRow({ offer, source }: { offer: RateOffer; source: string }) {
  const t = useTranslations("stayRates");
  const format = useFormatter();
  const { rate } = offer;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: rate.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const taxes =
    rate.taxes_included === true
      ? t("taxesIncluded")
      : rate.taxes_included === false
        ? rate.taxes != null
          ? t("taxesExtra", { amount: money(rate.taxes) })
          : t("taxesExtraUnknown")
        : t("taxesUnknown");
  const fees =
    rate.fees_at_property == null
      ? t("feesUnknown")
      : rate.fees_at_property === 0
        ? t("noFees")
        : t("fees", { amount: money(rate.fees_at_property) });
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm",
        offer.cheapest && "border-success/50 bg-success/5",
      )}
      data-testid="stay-rate"
    >
      <span className="flex min-w-32 items-center gap-1.5 font-medium">
        <Store className="text-muted-foreground size-3.5" aria-hidden />
        {rate.seller}
        {rate.is_property && (
          <span className="text-muted-foreground text-[11px] font-normal">{t("property")}</span>
        )}
        {rate.sponsored && (
          <span
            className="text-muted-foreground rounded border px-1 text-[10px] font-normal"
            data-testid="stay-rate-sponsored"
          >
            {t("sponsored")}
          </span>
        )}
      </span>
      <span className="grid">
        <span className="font-semibold tabular-nums" data-testid="stay-rate-final">
          {offer.final_total != null ? money(offer.final_total) : money(rate.price_total)}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {offer.final_total != null ? t("final") : t("finalUnknown")}
        </span>
      </span>
      <span className="text-muted-foreground basis-full text-xs sm:flex-1 sm:basis-auto">
        {[
          offer.final_total != null && offer.final_total !== rate.price_total
            ? t("sellerPrice", { amount: money(rate.price_total) })
            : null,
          taxes,
          fees,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {offer.cheapest && <span className="text-xs font-medium text-success">{t("cheapest")}</span>}
      {rate.deep_link && (
        <a
          href={outboundHref(rate.deep_link, "stay", source)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
        >
          {t("view")}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      )}
    </li>
  );
}
