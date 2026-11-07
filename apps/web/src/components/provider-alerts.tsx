import type { ProviderStatus } from "@tickets/shared";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";

/** Graceful degradation: показуємо, які джерела не відповіли, але не ховаємо результати. */
export function ProviderAlerts({ providers }: { providers: ProviderStatus[] }) {
  const t = useTranslations("results");
  const failed = providers.filter((p) => p.status !== "ok");
  const providerName = (id: string) => (t.has(`provider.${id}`) ? t(`provider.${id}`) : id);
  if (failed.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {failed.map((p) => (
        <li
          key={p.provider}
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          {p.status === "rate_limited"
            ? t("providerQuota", { provider: providerName(p.provider) })
            : p.status === "unsupported"
              ? t(p.error === "cabin" ? "providerNoCabin" : "providerNoParty", {
                  provider: providerName(p.provider),
                })
              : t("providerFailed", {
                  provider: providerName(p.provider),
                  reason: p.status === "timeout" ? t("reasonTimeout") : (p.error ?? p.status),
                })}
        </li>
      ))}
    </ul>
  );
}
