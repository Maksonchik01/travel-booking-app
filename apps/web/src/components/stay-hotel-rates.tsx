"use client";

import type { StayQuery } from "@tickets/shared";
import { useEffect, useState } from "react";

import { type RatesCheck, StayRates, requestStayRates } from "@/components/stay-rates";

/**
 * «Номери й ціни» на сторінці об'єкта (ADR 0044): тарифи продавців підвантажуються самі —
 * користувач відкрив сторінку саме заради них. Платне джерело — 1 запит, далі кеш 30 хв.
 */
export function StayHotelRates({
  query,
  source,
  stayId,
  now,
}: {
  query: StayQuery;
  source: string;
  stayId: string;
  /** Час рендеру (ISO): Date з сервера в клієнтський компонент не передається. */
  now: string;
}) {
  const [check, setCheck] = useState<RatesCheck>({ state: "loading" });

  async function load() {
    setCheck({ state: "loading" });
    setCheck({ state: "done", result: await requestStayRates(query, source, stayId) });
  }

  useEffect(() => {
    let active = true;
    void requestStayRates(query, source, stayId).then((result) => {
      if (active) setCheck({ state: "done", result });
    });
    return () => {
      active = false;
    };
  }, [query, source, stayId]);

  return (
    <StayRates check={check} now={new Date(now)} source={source} onRetry={() => void load()} />
  );
}
