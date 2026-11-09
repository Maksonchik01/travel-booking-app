import { Bell, BellOff, Trash2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { AlertManage } from "@/components/alert-manage";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent } from "@/components/ui/card";
import { fetchAlert, fetchAlertChannels, fetchAlertHistory } from "@/lib/api";
import type { RawSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/** Керування підпискою за посиланням із бота чи листа (токен — у посиланні, акаунта немає). */
export default function AlertPage({ searchParams }: PageProps<"/[locale]/alerts">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="flights" />
      <main id="main" tabIndex={-1} className="outline-none relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 py-8 sm:py-12">
          <Suspense fallback={<div className="shimmer h-64 rounded-xl" />}>
            <AlertDetails searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function AlertDetails({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const token = typeof raw.token === "string" ? raw.token : "";
  const done = typeof raw.done === "string" ? raw.done : null;
  const t = await getTranslations("alertPage");
  const [result, channels, history] = await Promise.all([
    token ? fetchAlert(token) : Promise.resolve(null),
    fetchAlertChannels(),
    token ? fetchAlertHistory(token) : Promise.resolve([]),
  ]);
  if (done === "delete") {
    return (
      <Card className="py-0">
        <CardContent className="grid gap-2 p-6 text-center" role="status">
          <Trash2 className="text-muted-foreground mx-auto size-8" aria-hidden />
          <h1 className="text-lg font-semibold">{t("done.delete")}</h1>
          <p className="text-muted-foreground text-sm">{t("deletedHint")}</p>
        </CardContent>
      </Card>
    );
  }
  if (!result || !result.ok) {
    return (
      <Card className="py-0">
        <CardContent className="grid gap-2 p-6 text-center">
          <BellOff className="text-muted-foreground mx-auto size-8" aria-hidden />
          <h1 className="text-lg font-semibold">{t("notFound")}</h1>
          <p className="text-muted-foreground text-sm">{t("notFoundHint")}</p>
        </CardContent>
      </Card>
    );
  }
  const alert = result.data;
  const telegramLink =
    alert.channel === "telegram" && alert.status === "pending" && channels?.bot_username
      ? `https://t.me/${channels.bot_username}?start=${token}`
      : null;
  const known = done && t.has(`done.${done}`) ? done : done ? "failed" : null;
  return (
    <Card className="border-primary/10 shadow-primary/[0.07] py-0 shadow-xl">
      <CardContent className="grid gap-5 p-5 sm:p-6">
        {known && (
          <p
            role="status"
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              known === "failed" || known === "editFailed"
                ? "border-warning/40 bg-warning/10"
                : "border-success/40 bg-success/5 text-success",
            )}
          >
            {t(`done.${known}`)}
          </p>
        )}
        <p className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
          <Bell className="text-primary size-3.5" aria-hidden />
          {t("title")}
        </p>
        <AlertManage
          alert={alert}
          token={token}
          history={history}
          back="link"
          telegramLink={telegramLink}
          heading="h1"
        />
        <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
      </CardContent>
    </Card>
  );
}
