"use client";

import type { Stay, StayAnalysisResult, StayQuery } from "@tickets/shared";
import { AlertTriangle, Loader2, MessageSquareText, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/client-fetch";

type Props = {
  query: StayQuery;
  /** Об'єкти «Нашого вибору» — для них і резюме (не більше трьох). */
  stays: Stay[];
  /** Підміна мережі в тестах. */
  analyze?: (query: StayQuery, keys: string[]) => Promise<StayAnalysisResult | null>;
};

async function analyzeViaApi(query: StayQuery, keys: string[]): Promise<StayAnalysisResult | null> {
  const response = await fetchWithTimeout("/api/ai/stays/analysis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Мова резюме — мова сторінки (<html lang>, її ставить кореневий layout).
    body: JSON.stringify({ query, stay_keys: keys, locale: document.documentElement.lang }),
  });
  return response.ok ? ((await response.json()) as StayAnalysisResult) : null;
}

/**
 * Резюме відгуків від ШІ — лише на вимогу: для реального джерела відгуки кожного об'єкта —
 * окремий платний запит. Value-score рахує код; ШІ підсумовує відгуки й пояснює вибір.
 */
export function StayAnalysis({ query, stays, analyze = analyzeViaApi }: Props) {
  const t = useTranslations("stayAnalysis");
  const [result, setResult] = useState<StayAnalysisResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const names = new Map(stays.map((s) => [s.id, s.name]));

  function run() {
    setFailed(false);
    startTransition(async () => {
      let data: StayAnalysisResult | null;
      try {
        data = await analyze(
          query,
          stays.map((s) => `${s.source}:${s.id}`),
        );
      } catch {
        data = null;
      }
      if (!data || data.status !== "ok" || !data.analysis) {
        setFailed(true);
        return;
      }
      setResult(data);
    });
  }

  const analysis = result?.analysis;
  if (!analysis) {
    return (
      <div className="border-primary/25 from-primary/[0.05] to-card flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-gradient-to-br p-4">
        <div className="grid gap-0.5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <MessageSquareText className="text-primary size-4" aria-hidden />
            {t("title")}
          </p>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
          {failed && (
            <p role="alert" className="text-xs text-warning">
              {t("error")}
            </p>
          )}
        </div>
        <Button
          type="button"
          onClick={run}
          disabled={pending}
          className="shadow-primary/25 shadow-md transition-all hover:-translate-y-px hover:shadow-lg"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {pending ? t("running") : t("run")}
        </Button>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="stay-analysis-title"
      className="border-primary/25 from-primary/[0.06] to-card animate-in fade-in-0 slide-in-from-bottom-2 grid gap-3 rounded-xl border bg-gradient-to-br p-4 duration-300 sm:p-5"
      data-testid="stay-analysis"
    >
      <h2 id="stay-analysis-title" className="flex items-center gap-2 font-semibold">
        <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-lg">
          <Sparkles className="size-4" aria-hidden />
        </span>
        {t("title")}
      </h2>
      <p className="text-sm">
        <span className="font-medium">
          {t("topPick", { name: names.get(analysis.top_pick_id) ?? analysis.top_pick_id })}
        </span>{" "}
        {analysis.top_pick_reason}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {analysis.stays?.map((insight) => (
          <li
            key={insight.id}
            className="bg-card grid content-start gap-1.5 rounded-lg border p-3 text-xs shadow-xs"
          >
            <p className="font-medium">{names.get(insight.id) ?? insight.id}</p>
            <p
              className={cn(
                "w-fit rounded px-1.5 py-0.5 text-[11px] font-medium",
                insight.reliability === "low"
                  ? "bg-warning/10 text-warning"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {t(`reliability.${insight.reliability ?? "medium"}`)}
              {insight.reliability_note ? ` · ${insight.reliability_note}` : null}
            </p>
            <Points items={insight.pros} sign="+" className="text-success" />
            <Points items={insight.cons} sign="−" className="text-muted-foreground" />
            {insight.red_flags && insight.red_flags.length > 0 && (
              <ul className="grid gap-0.5 text-warning">
                {insight.red_flags.map((flag, i) => (
                  <li key={i} className="flex gap-1">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {flag}
                  </li>
                ))}
              </ul>
            )}
            {insight.best_for && (
              <p className="text-muted-foreground">
                {t("bestFor")} {insight.best_for}
              </p>
            )}
          </li>
        ))}
      </ul>
      {analysis.price_vs_location_note && (
        <p className="text-muted-foreground text-xs">{analysis.price_vs_location_note}</p>
      )}
      <p className="text-muted-foreground text-[11px]">{t("disclaimer")}</p>
    </section>
  );
}

function Points({ items, sign, className }: { items?: string[]; sign: string; className: string }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className={cn("grid gap-0.5", className)}>
      {items.map((item, i) => (
        <li key={i}>
          {sign} {item}
        </li>
      ))}
    </ul>
  );
}
