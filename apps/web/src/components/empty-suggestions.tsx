import { ArrowRight, Lightbulb } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import type { Suggestion } from "@/lib/empty-suggestions";
import { fractionDigits } from "@/lib/money";

/**
 * Корисні альтернативи для порожніх результатів (модуль 20.5): кожна — посилання з однією
 * названою зміною. Нічого не застосовуємо самі: обов'язкові умови змінює лише людина.
 */
export function EmptySuggestions({
  items,
  currency = "EUR",
}: {
  items: Suggestion[];
  currency?: string;
}) {
  const t = useTranslations("emptyHelp");
  const format = useFormatter();
  if (items.length === 0) return null;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  return (
    <section
      className="grid gap-2"
      aria-labelledby="empty-help-title"
      data-testid="empty-suggestions"
    >
      <h2 id="empty-help-title" className="flex items-center gap-2 text-sm font-semibold">
        <Lightbulb className="text-primary size-4" aria-hidden />
        {t("title")}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {items.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className="bg-card hover:border-primary/50 hover:text-primary flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors"
              data-testid="empty-suggestion"
              data-suggestion={s.key}
            >
              {t(`item.${s.key}`, { amount: s.amount != null ? money(s.amount) : "" })}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">{t("hint")}</p>
    </section>
  );
}
