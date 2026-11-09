"use client";

import type { FlightQuery, Offer, SellerOffer, SellersResult } from "@tickets/shared";
import { ArrowUpRight, BadgeCheck, Loader2, Store } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { hoursAgo } from "@/lib/format";
import { RetryNotice } from "@/components/retry";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { outboundHref } from "@/lib/outbound";
import { cn } from "@/lib/utils";

type Check = { state: "idle" } | { state: "loading" } | { state: "done"; result: SellersResult };

/**
 * Пропозиції продавців рейсу (модуль 3). Рядки — той самий рейс з інших джерел (кожен зі своїми
 * умовами: тарифи з різним багажем не видаємо за однакові). Для джерел з перевіркою (SerpApi) —
 * «Порівняти продавців»: продавці й ціна зараз, це ж і перевірка перед переходом. Один продавець
 * — без імітації порівняння.
 */
export function SellerOffers({
  offer,
  rows,
  query,
  now: nowIso,
}: {
  offer: Offer;
  /** Пропозиції того самого рейсу (разом з `offer`), від найдешевшої. */
  rows: Offer[];
  query: FlightQuery;
  /** Час рендеру сторінки (ISO) — Date з сервера в клієнтський компонент не передається. */
  now: string;
}) {
  const now = new Date(nowIso);
  const t = useTranslations("sellers");
  const tResults = useTranslations("results");
  const format = useFormatter();
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const checkable = rows.find((o) => o.booking_ref);
  const money = (value: number, currency: string) =>
    format.number(value, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const source = (o: Offer) =>
    o.seller ??
    (tResults.has(`provider.${o.source}`) ? tResults(`provider.${o.source}`) : o.source);

  if (rows.length < 2 && !checkable) return null;

  async function verify() {
    if (!checkable?.booking_ref) return;
    setCheck({ state: "loading" });
    try {
      const response = await fetchWithTimeout("/api/flights/sellers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          source: checkable.source,
          booking_ref: checkable.booking_ref,
        }),
      });
      setCheck({ state: "done", result: (await response.json()) as SellersResult });
    } catch {
      setCheck({ state: "done", result: { status: "error", sellers: [] } });
    }
  }

  const live = rows.filter((o) => o.price_status === "live");
  const cheapestLive = live.length ? Math.min(...live.map((o) => o.price)) : null;

  return (
    <section className="grid gap-2 border-t px-4 py-3 text-sm sm:px-5" data-testid="seller-offers">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
        <Store className="text-primary size-3.5" aria-hidden />
        {rows.length > 1 ? t("title") : t("titleOne")}
      </h3>

      {rows.length > 1 && (
        <ul className="grid gap-1.5">
          {rows.map((o) => (
            <li
              key={`${o.source}:${o.id}`}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
                o.price_status === "live" &&
                  o.price === cheapestLive &&
                  "border-success/50 bg-success/5",
              )}
              data-testid="seller-row"
            >
              <span className="min-w-28 font-medium">{source(o)}</span>
              <span className="font-semibold tabular-nums">{money(o.price, o.currency)}</span>
              <span className="text-muted-foreground flex-1 text-xs">
                {[
                  o.baggage_included === true
                    ? t("bagIncluded")
                    : o.baggage_included === false
                      ? t("bagNotIncluded")
                      : t("bagUnknown"),
                  o.price_status === "live"
                    ? t("live", { hours: hoursAgo(o.collected_at, now) })
                    : t("cached"),
                ].join(" · ")}
              </span>
              {o.deep_link && (
                <a
                  href={outboundHref(o.deep_link, "flight", o.source)}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
                >
                  {t("view")}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      {checkable && check.state === "idle" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={verify}>
            {t("compare")}
          </Button>
          <span className="text-muted-foreground text-xs">{t("compareHint")}</span>
        </div>
      )}
      {check.state === "loading" && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("checking")}
        </p>
      )}
      {check.state === "done" && (
        <CheckedSellers
          result={check.result}
          searchPrice={checkable?.price ?? offer.price}
          currency={offer.currency}
          source={checkable?.source ?? offer.source}
          now={now}
          money={money}
          onRetry={() => void verify()}
        />
      )}
      {!checkable && <p className="text-muted-foreground text-xs">{t("finalAtSeller")}</p>}
    </section>
  );
}

function CheckedSellers({
  result,
  searchPrice,
  currency,
  source,
  now,
  money,
  onRetry,
}: {
  onRetry: () => void;
  result: SellersResult;
  searchPrice: number;
  currency: string;
  source: string;
  now: Date;
  money: (value: number, currency: string) => string;
}) {
  const t = useTranslations("sellers");
  if (result.status !== "ok" || result.sellers.length === 0) {
    const key =
      result.status === "rate_limited"
        ? "rateLimited"
        : result.status === "unsupported" || result.status === "ok"
          ? "finalAtSeller"
          : "checkFailed";
    if (key === "checkFailed") return <RetryNotice message={t(key)} onRetry={onRetry} />;
    return (
      <p className="text-muted-foreground text-xs" role="status">
        {t(key)}
      </p>
    );
  }
  const sellers = result.sellers;
  const cheapest = Math.min(...sellers.map((s) => s.price));
  const changed = Math.round(cheapest) !== Math.round(searchPrice);
  const minutes = result.checked_at
    ? Math.max(0, Math.round((now.getTime() - Date.parse(result.checked_at)) / 60_000))
    : null;
  return (
    <div className="grid gap-1.5" data-testid="checked-sellers">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <BadgeCheck className="size-3.5 text-success" aria-hidden />
        {minutes != null && minutes > 1 ? t("checkedMinutes", { minutes }) : t("checkedNow")}
      </p>
      {changed && (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs"
          role="status"
        >
          {t("priceChanged", {
            before: money(searchPrice, currency),
            now: money(cheapest, currency),
          })}
        </p>
      )}
      <ul className="grid gap-1.5">
        {sellers.map((s) => (
          <SellerRow
            key={`${s.seller}|${s.price}`}
            seller={s}
            cheapest={sellers.length > 1 && s.price === cheapest}
            source={source}
            money={money}
          />
        ))}
      </ul>
    </div>
  );
}

function SellerRow({
  seller,
  cheapest,
  source,
  money,
}: {
  seller: SellerOffer;
  cheapest: boolean;
  source: string;
  money: (value: number, currency: string) => string;
}) {
  const t = useTranslations("sellers");
  const link = seller.link;
  // Перехід Google — POST з даними від джерела; облік кліку — окремим запитом.
  const fields = link?.method === "POST" ? [...new URLSearchParams(link.post_data ?? "")] : [];
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        cheapest && "border-success/50 bg-success/5",
      )}
      data-testid="checked-seller"
    >
      <span className="min-w-28 font-medium">
        {seller.seller}
        {seller.is_airline && (
          <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
            {t("airline")}
          </span>
        )}
      </span>
      <span className="font-semibold tabular-nums">{money(seller.price, seller.currency)}</span>
      <span className="text-muted-foreground flex-1 text-xs">
        {seller.included?.length ? seller.included.join(", ") : t("includedUnknown")}
      </span>
      {link && (
        <form
          method={link.method === "POST" ? "post" : "get"}
          action={link.url}
          target="_blank"
          rel="noopener noreferrer"
          onSubmit={() => {
            void fetch("/api/outbound", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ source, host: new URL(link.url).host }),
              keepalive: true,
            }).catch(() => undefined);
          }}
        >
          {fields.map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <Button type="submit" size="sm" variant={cheapest ? "default" : "outline"}>
            {t("view")}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Button>
        </form>
      )}
    </li>
  );
}
