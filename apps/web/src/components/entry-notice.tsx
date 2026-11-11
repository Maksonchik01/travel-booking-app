import { Info } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * Дрібне попередження в Explore: правила в'їзду (віза, документи, обмеження) ми не перевіряємо —
 * людина з'ясовує їх сама до покупки. Не юридична порада, лише нагадування.
 */
export function EntryNotice({ className }: { className?: string }) {
  const t = useTranslations("explore");
  return (
    <p
      className={cn("text-muted-foreground flex gap-1.5 text-[11px] leading-snug", className)}
      data-testid="entry-notice"
    >
      <Info className="mt-px size-3 shrink-0" aria-hidden />
      <span>{t("entryNotice")}</span>
    </p>
  );
}
