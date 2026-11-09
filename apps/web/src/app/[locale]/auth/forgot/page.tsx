import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ForgotForm } from "@/components/auth-forms";
import { AuthShell } from "@/components/auth-shell";

export default async function ForgotPage() {
  const t = await getTranslations("auth");
  return (
    <AuthShell title={t("forgotTitle")} subtitle={t("forgotSubtitle")}>
      <ForgotForm />
      <Link
        href="/login"
        className="text-primary justify-self-center text-sm underline-offset-4 hover:underline"
      >
        {t("backToLogin")}
      </Link>
    </AuthShell>
  );
}
