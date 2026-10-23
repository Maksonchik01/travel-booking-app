import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ServiceStatus } from "@/components/service-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchReadiness } from "@/lib/api";

async function LiveServiceStatus() {
  const status = await fetchReadiness();
  return <ServiceStatus status={status} />;
}

async function StatusFallback() {
  const t = await getTranslations("status");
  return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
}

export default function HomePage() {
  const t = useTranslations();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t("home.title")}</h1>
        <p className="text-muted-foreground">{t("home.subtitle")}</p>
        <p className="text-muted-foreground text-sm">{t("home.comingSoon")}</p>
      </header>
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>{t("status.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Стан API читається на кожен запит: стрімимо його за Suspense. */}
          <Suspense fallback={<StatusFallback />}>
            <LiveServiceStatus />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
