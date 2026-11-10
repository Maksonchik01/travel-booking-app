import type { ExplainResult, PickLabel } from "@tickets/shared";
import { AlertTriangle, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

const PICK_LABELS: readonly PickLabel[] = ["cheapest", "fastest", "balanced"];

function isPickLabel(id: string): id is PickLabel {
  return (PICK_LABELS as readonly string[]).includes(id);
}

/**
 * Пояснення ШІ поверх готового скорингу. Числа в ньому перевірені бекендом: кожне є
 * в результатах пошуку. Немає пояснення — блоку немає, результати від цього не залежать.
 */
export function AIExplanation({ result }: { result: ExplainResult }) {
  const t = useTranslations("ai");
  const tPicks = useTranslations("picks");
  const explanation = result.explanation;
  if (result.status !== "ok" || !explanation) return null;
  const label = (id: string) => (isPickLabel(id) ? tPicks(`label.${id}`) : id);

  return (
    <section
      aria-labelledby="ai-explanation-title"
      className="border-primary/25 from-primary/[0.06] to-card animate-in fade-in-0 slide-in-from-bottom-2 grid gap-3 rounded-xl border bg-gradient-to-br p-4 duration-300 sm:p-5"
      data-testid="ai-explanation"
    >
      <h2 id="ai-explanation-title" className="flex items-center gap-2 font-semibold">
        <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-lg">
          <Sparkles className="size-4" aria-hidden />
        </span>
        {t("explanationTitle")}
      </h2>
      <p className="text-sm leading-relaxed">{explanation.summary}</p>
      <p className="text-sm">
        <span className="font-medium">
          {t("recommended", { label: label(explanation.recommended_id) })}
        </span>{" "}
        {explanation.recommendation_reason}
      </p>

      {/* Порівняння варіантів і примітки — другорядне (модуль 23e): під «Докладніше». */}
      <details className="group grid gap-3 text-sm" data-testid="ai-explanation-more">
        <summary className="text-primary w-fit cursor-pointer list-none text-xs font-medium select-none hover:underline">
          {t("more")}
        </summary>
        <div className="mt-3 grid gap-3">
          {explanation.options && explanation.options.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {explanation.options.map((option) => (
                <li
                  key={option.id}
                  className="bg-card grid content-start gap-1.5 rounded-lg border p-3 text-xs shadow-xs"
                >
                  <p className="font-medium">{label(option.id)}</p>
                  {option.one_liner && <p>{option.one_liner}</p>}
                  <Points items={option.pros} sign="+" className="text-success" />
                  <Points items={option.cons} sign="−" className="text-muted-foreground" />
                  {option.risks && option.risks.length > 0 && (
                    <ul className="grid gap-0.5 text-warning">
                      {option.risks.map((risk, i) => (
                        <li key={i} className="flex gap-1">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                          {risk}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="text-muted-foreground grid gap-0.5 text-xs">
            {explanation.price_assessment?.text && <p>{explanation.price_assessment.text}</p>}
            {explanation.timing_advice?.text && <p>{explanation.timing_advice.text}</p>}
            {explanation.data_freshness_note && <p>{explanation.data_freshness_note}</p>}
          </div>
          <p className="text-muted-foreground text-[11px]">{t("explanationDisclaimer")}</p>
        </div>
      </details>
    </section>
  );
}

function Points({ items, sign, className }: { items?: string[]; sign: string; className: string }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className={`grid gap-0.5 ${className}`}>
      {items.map((item, i) => (
        <li key={i}>
          {sign} {item}
        </li>
      ))}
    </ul>
  );
}
