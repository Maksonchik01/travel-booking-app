import type { SearchEntry } from "@tickets/shared";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { clearHistory } from "@/app/actions/account";
import { AccountPage, Entries, Section, requireAccount } from "@/components/account-shell";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/session";

/** Кабінет → «Історія пошуку»: збережені пошуки й останні (повторити, видалити, очистити). */
export default function HistoryPage({ searchParams }: PageProps<"/[locale]/account/history">) {
  return (
    <AccountPage section="history" searchParams={searchParams}>
      <History />
    </AccountPage>
  );
}

async function History() {
  const { token } = await requireAccount("history");
  const [saved, history] = await Promise.all([
    call<SearchEntry[]>("GET", "/account/searches?saved=true", undefined, token),
    call<SearchEntry[]>("GET", "/account/searches?saved=false&limit=50", undefined, token),
  ]);
  return (
    <HistoryView saved={saved.ok ? saved.data : []} history={history.ok ? history.data : []} />
  );
}

function HistoryView({ saved, history }: { saved: SearchEntry[]; history: SearchEntry[] }) {
  const t = useTranslations("account");
  return (
    <>
      <Section id="saved" title={t("nav.saved")} hint={t("savedHint")}>
        <Entries entries={saved} empty={t("savedEmpty")} renamable />
      </Section>
      <Section
        id="history"
        title={t("nav.history")}
        hint={t("historyHint")}
        action={
          history.length > 0 && (
            <form action={clearHistory}>
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
                {t("clearHistory")}
              </Button>
            </form>
          )
        }
      >
        <Entries entries={history} empty={t("historyEmpty")} savable />
      </Section>
    </>
  );
}
