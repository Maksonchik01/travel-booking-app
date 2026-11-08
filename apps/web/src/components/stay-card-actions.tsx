"use client";

import type { FavoriteStayInput, Stay, StayQuery } from "@tickets/shared";
import { ChevronDown, Columns3, Luggage } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FavoriteToggle } from "@/components/favorites";
import { type RatesCheck, StayRates, requestStayRates } from "@/components/stay-rates";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/lib/use-hydrated";

type Panel = "details" | "rates" | null;

/**
 * Дії картки житла (модуль 7): «Детальніше» — усе, що відомо від джерела; «Порівняти ціни» —
 * тарифи продавців (лише якщо джерело їх дає); «В обране»; «Додати до поїздки» — у планувальник
 * з цим житлом, містом і датами.
 */
export function StayCardActions({
  stay,
  query,
  favorite,
  tripHref,
  now: nowIso,
  details,
}: {
  stay: Stay;
  query: StayQuery;
  favorite: FavoriteStayInput;
  tripHref: string;
  /** Час рендеру (ISO): Date з сервера в клієнтський компонент не передається. */
  now: string;
  /** Вміст «Детальніше» — рендерить сервер (без зайвого JS). */
  details: React.ReactNode;
}) {
  const t = useTranslations("stayCard");
  const [panel, setPanel] = useState<Panel>(null);
  const [check, setCheck] = useState<RatesCheck>({ state: "idle" });
  const comparable = stay.sellers != null;
  // Клієнтські панелі: до гідратації кнопки неактивні (клік би загубився).
  const hydrated = useHydrated();

  async function openRates() {
    if (panel === "rates") return setPanel(null);
    setPanel("rates");
    if (check.state !== "idle") return;
    setCheck({ state: "loading" });
    setCheck({ state: "done", result: await requestStayRates(query, stay.source, stay.id) });
  }

  return (
    <div className="grid gap-3 border-t px-4 py-3 sm:col-span-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={panel === "details"}
          disabled={!hydrated}
          onClick={() => setPanel(panel === "details" ? null : "details")}
          data-testid="stay-details-toggle"
        >
          <ChevronDown
            className={panel === "details" ? "size-3.5 rotate-180" : "size-3.5"}
            aria-hidden
          />
          {t("details")}
        </Button>
        {comparable && (
          <Button
            type="button"
            variant={panel === "rates" ? "secondary" : "outline"}
            size="sm"
            aria-expanded={panel === "rates"}
            disabled={!hydrated}
            onClick={openRates}
            data-testid="stay-rates-toggle"
          >
            <Columns3 className="size-3.5" aria-hidden />
            {t("comparePrices")}
          </Button>
        )}
        <FavoriteToggle stay={favorite} />
        <Button asChild variant="outline" size="sm">
          <Link href={tripHref} data-testid="stay-add-to-trip">
            <Luggage className="size-3.5" aria-hidden />
            {t("addToTrip")}
          </Link>
        </Button>
      </div>
      {panel === "details" && <div data-testid="stay-details">{details}</div>}
      {panel === "rates" && <StayRates check={check} now={new Date(nowIso)} source={stay.source} />}
    </div>
  );
}
