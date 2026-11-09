import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * Повідомлення на місці результатів: порожньо, нічого не знайдено чи помилка. Помилка —
 * `role="alert"` і «Спробувати ще раз» (звичайне посилання на той самий пошук — працює й без JS).
 */
export function PageNotice({
  children,
  tone = "info",
  retryHref,
}: {
  children: React.ReactNode;
  tone?: "info" | "error";
  retryHref?: string;
}) {
  const t = useTranslations("common");
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "bg-card grid justify-items-center gap-3 rounded-xl border px-4 py-8 text-center text-sm",
        tone === "error" ? "border-destructive/40 text-destructive" : "text-muted-foreground",
      )}
    >
      <p>{children}</p>
      {retryHref && (
        <a
          href={retryHref}
          className="bg-card text-foreground hover:border-primary/50 hover:text-primary inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t("retry")}
        </a>
      )}
    </div>
  );
}
