"use client";

import { CalendarRange } from "lucide-react";
import { useTranslations } from "next-intl";

import { DATE_PRESETS, type DatePreset } from "@/lib/date-presets";

/**
 * Швидкі дати (модуль 3): найближчі й наступні вихідні, вихідні місяця, 3–4 та 5–7 днів.
 * Лише заповнюють поля форми — пошук, як завжди, кнопкою.
 */
export function DatePresets({
  onPick,
  testId = "date-presets",
}: {
  onPick: (preset: DatePreset) => void;
  testId?: string;
}) {
  const t = useTranslations("datePresets");
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t("label")}
      data-testid={testId}
    >
      <CalendarRange className="text-muted-foreground size-3.5" aria-hidden />
      {DATE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          onClick={() => onPick(preset)}
          className="hover:border-primary hover:text-primary rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
          data-testid={`preset-${preset}`}
        >
          {t(preset)}
        </button>
      ))}
    </div>
  );
}
