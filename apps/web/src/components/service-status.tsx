import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { ApiStatus } from "@/lib/api";

const CHECK_KEYS = ["database", "redis"] as const;

export function ServiceStatus({ status }: { status: ApiStatus }) {
  const t = useTranslations("status");

  if (status.kind === "unreachable") {
    return <Badge variant="destructive">{t("unreachable")}</Badge>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Badge variant={status.kind === "ok" ? "default" : "destructive"}>{t(status.kind)}</Badge>
      <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
        {CHECK_KEYS.map((key) => {
          const check = status.data.checks[key];
          return (
            <li key={key} className="flex items-center justify-between gap-4">
              <span>{t(`checks.${key}`)}</span>
              <span data-testid={`check-${key}`}>
                {check?.status === "ok"
                  ? t("checkOk", { ms: check.latency_ms ?? 0 })
                  : t("checkError")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
