"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Помилка асинхронного блоку з повторною спробою (модуль 13.2): текст, що сталося, і кнопка
 * «Спробувати ще раз». `role="alert"` — screen reader повідомить одразу.
 */
export function RetryNotice({
  message,
  onRetry,
  pending = false,
  className,
}: {
  message: string;
  onRetry?: () => void;
  pending?: boolean;
  className?: string;
}) {
  const t = useTranslations("common");
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-warning",
        className,
      )}
      data-testid="retry-notice"
    >
      <span>{message}</span>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={onRetry}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="size-3.5" aria-hidden />
          )}
          {t("retry")}
        </Button>
      )}
    </div>
  );
}
