import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { VerifyEmailForm } from "@/components/auth-forms";
import { AuthShell } from "@/components/auth-shell";

export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/[locale]/auth/verify-email">) {
  const t = await getTranslations("auth");
  return (
    <AuthShell title={t("verifyTitle")} subtitle={t("verifySubtitle")}>
      <Suspense fallback={null}>
        <TokenForm searchParams={searchParams} />
      </Suspense>
      <Link
        href="/account"
        className="text-primary justify-self-center text-sm underline-offset-4 hover:underline"
      >
        {t("toAccount")}
      </Link>
    </AuthShell>
  );
}

async function TokenForm({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const { token } = await searchParams;
  return <VerifyEmailForm token={typeof token === "string" ? token : ""} />;
}
