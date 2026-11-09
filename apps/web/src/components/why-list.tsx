import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import { splitDuration } from "@/lib/format";

/** «4 год», «4 год 10 хв», «45 хв» — для причин «Чому цей варіант?». */
export function useDurationText(): (minutes: number) => string {
  const t = useTranslations("picks");
  return (total) => {
    const { hours, minutes } = splitDuration(total);
    if (hours === 0) return t("minutes", { minutes });
    return minutes === 0 ? t("hours", { hours }) : t("hoursMinutes", { hours, minutes });
  };
}

/**
 * Список причин «Чому цей варіант?» (модуль 14.5): тексти вже з числами, які порахував API, —
 * для перельотів, житла й поїздки однаково.
 */
export function WhyList({ items, testId }: { items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-1 text-xs" data-testid={testId}>
      {items.map((text, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <Check className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
          {text}
        </li>
      ))}
    </ul>
  );
}
