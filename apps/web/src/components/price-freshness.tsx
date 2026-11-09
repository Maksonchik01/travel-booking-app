import type { PriceFreshness } from "@tickets/shared";
import { AlertTriangle, CircleCheck, Clock, Info } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

const STYLE: Record<PriceFreshness, { icon: typeof Clock; className: string }> = {
  live: { icon: CircleCheck, className: "text-success" },
  cached: { icon: Clock, className: "text-muted-foreground" },
  approximate: { icon: Info, className: "text-warning" },
  needs_recheck: { icon: AlertTriangle, className: "text-warning" },
};

/**
 * Наскільки свіжа ціна (модуль 17.3): рахує API від часу отримання; поруч — сам вік ціни.
 * «Варто перевірити» — перед переходом звірте ціну в продавця.
 */
export function FreshnessBadge({ value }: { value?: PriceFreshness }) {
  const t = useTranslations("freshness");
  if (!value) return null;
  const { icon: Icon, className } = STYLE[value];
  return (
    <span
      className={cn("flex items-center gap-1 text-xs font-medium", className)}
      title={t(`hint.${value}`)}
      data-testid="price-freshness"
      data-freshness={value}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {t(value)}
    </span>
  );
}
