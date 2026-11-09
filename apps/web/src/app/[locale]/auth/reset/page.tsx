import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ResetForm } from "@/components/auth-forms";
import { AuthShell } from "@/components/auth-shell";

export default async function ResetPage({ searchParams }: PageProps<"/[locale]/auth/reset">) {
  const t = await getTranslations("auth");
  return (
    <AuthShell title={t("resetTitle")}>
      <Suspense fallback={null}>
        <TokenForm searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function TokenForm({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const { token } = await searchParams;
  return <ResetForm token={typeof token === "string" ? token : ""} />;
}
