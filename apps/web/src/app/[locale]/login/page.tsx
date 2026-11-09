import type { AuthStatus } from "@tickets/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LoginForm, RegisterForm } from "@/components/auth-forms";
import { AuthShell } from "@/components/auth-shell";
import { GoogleButton } from "@/components/google-button";
import type { RawSearchParams } from "@/lib/search-params";
import { call } from "@/lib/session";
import { cn } from "@/lib/utils";

export default async function LoginPage({ searchParams }: PageProps<"/[locale]/login">) {
  const t = await getTranslations("auth");
  return (
    <AuthShell title={t("title")} subtitle={t("subtitle")}>
      <Suspense fallback={<div className="shimmer h-80 rounded-lg" />}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function LoginContent({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const register = raw.mode === "register";
  const next = typeof raw.next === "string" && raw.next.startsWith("/") ? raw.next : "/account";
  const error = typeof raw.error === "string" ? raw.error : null;
  const status = await call<AuthStatus>("GET", "/auth/status", undefined, null);
  const google = status.ok && status.data.google;
  return <LoginTabs register={register} next={next} error={error} google={google} />;
}

function LoginTabs({
  register,
  next,
  error,
  google,
}: {
  register: boolean;
  next: string;
  error: string | null;
  google: boolean;
}) {
  const t = useTranslations("auth");
  const tErr = useTranslations("authErrors");
  const tab = (mode: "login" | "register") =>
    `/login?${new URLSearchParams({ ...(mode === "register" ? { mode } : {}), next })}`;
  return (
    <>
      <nav aria-label={t("tabs")} className="bg-muted grid grid-cols-2 rounded-xl p-1 text-sm">
        {(["login", "register"] as const).map((mode) => {
          const active = (mode === "register") === register;
          return (
            <Link
              key={mode}
              href={tab(mode)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-2 text-center font-medium transition-all",
                active
                  ? "bg-card text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(mode === "login" ? "signIn" : "signUp")}
            </Link>
          );
        })}
      </nav>

      {error && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {tErr.has(error) ? tErr(error) : tErr("default")}
        </p>
      )}

      <GoogleButton enabled={google} />
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        {t("or")}
        <span className="bg-border h-px flex-1" />
      </div>

      {register ? <RegisterForm next={next} /> : <LoginForm next={next} />}

      {!register && (
        <Link
          href="/auth/forgot"
          className="text-primary justify-self-center text-sm underline-offset-4 hover:underline"
        >
          {t("forgot")}
        </Link>
      )}
    </>
  );
}
