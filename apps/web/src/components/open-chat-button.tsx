"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { openChat } from "@/lib/ai-events";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * «Оптимізувати з ШІ» (модуль 9b, планувальник → ШІ): відкриває вкладку помічника з новою
 * розмовою «Уся поїздка». Поїздку (з вибором рейсу й житла) чат бере з URL — без втрат.
 */
export function OptimizeWithAI() {
  const t = useTranslations("tripBuilder");
  const hydrated = useHydrated();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!hydrated}
      onClick={() => openChat({ mode: "trip", draft: t("optimizeDraft") })}
      data-testid="trip-optimize-ai"
    >
      <Sparkles className="size-3.5" aria-hidden />
      {t("optimize")}
    </Button>
  );
}
