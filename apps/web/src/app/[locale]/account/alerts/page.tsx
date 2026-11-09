import type { Account, AccountAlert, AlertEventOut } from "@tickets/shared";
import { Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { AccountPage, Section, requireAccount } from "@/components/account-shell";
import { AlertManage } from "@/components/alert-manage";
import { NotifyPrefsForm } from "@/components/security-forms";
import { Button } from "@/components/ui/button";
import { fetchAlertChannels, fetchAlertHistory } from "@/lib/api";
import { call } from "@/lib/session";

/** Кабінет → «Сповіщення»: підписки на ціну й налаштування сповіщень (модуль 10c). */
export default function AlertsPage({ searchParams }: PageProps<"/[locale]/account/alerts">) {
  return (
    <AccountPage section="alerts" searchParams={searchParams}>
      <Alerts />
    </AccountPage>
  );
}

async function Alerts() {
  const { account, token } = await requireAccount("alerts");
  const alerts = await call<AccountAlert[]>("GET", "/account/alerts", undefined, token);
  const list = alerts.ok ? alerts.data : [];
  // Історія — для кожної підписки (їх обмежено: ALERT_MAX_ACTIVE_PER_OWNER).
  const [history, channels] = await Promise.all([
    Promise.all(list.map((a) => fetchAlertHistory(a.manage_token))),
    fetchAlertChannels(),
  ]);
  return (
    <AlertsView
      account={account}
      alerts={list}
      history={history}
      max={channels?.max_active_per_owner ?? null}
    />
  );
}

function AlertsView({
  account,
  alerts,
  history,
  max,
}: {
  account: Account;
  alerts: AccountAlert[];
  history: AlertEventOut[][];
  max: number | null;
}) {
  const t = useTranslations("account");
  const tCab = useTranslations("cabinet");
  const open = alerts.filter((a) => a.status !== "stopped" && a.status !== "expired").length;
  return (
    <>
      <Section
        id="alerts"
        title={t("nav.alerts")}
        hint={t("alertsHint")}
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/">
              <Search className="size-3.5" aria-hidden />
              {tCab("action.newAlert")}
            </Link>
          </Button>
        }
      >
        <p className="text-muted-foreground text-xs">
          {tCab("alertHow")} {max != null && t("alertsLimit", { open, max })}
        </p>
        {alerts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("alertsEmpty")}</p>
        ) : (
          <ul className="grid gap-3">
            {alerts.map((a, i) => (
              <li key={a.id} className="rounded-xl border p-4">
                <AlertManage alert={a} token={a.manage_token} history={history[i]} back="account" />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="notify" title={t("notify.title")} hint={t("notify.hint")}>
        <NotifyPrefsForm account={account} />
      </Section>
    </>
  );
}
