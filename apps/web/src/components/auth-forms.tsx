"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  type FormState,
  forgotPassword,
  login,
  register,
  resetPassword,
  verifyEmail,
} from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FIELD_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

const IDLE: FormState = { status: "idle" };

export function FormError({ state }: { state: FormState }) {
  const t = useTranslations("authErrors");
  if (state.status !== "error") return null;
  const code = state.code ?? "default";
  return (
    <p
      role="alert"
      className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
    >
      {t.has(code) ? t(code) : t("default")}
    </p>
  );
}

export function Submit({ children, className }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      className={cn("shadow-primary/25 h-11 rounded-lg shadow-md", className)}
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

export function Field({
  label,
  hint,
  ...input
}: React.ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={input.id} className="text-muted-foreground text-xs font-medium">
        {label}
      </Label>
      <Input {...input} className={cn(FIELD_CLASS, input.className)} />
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </div>
  );
}

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(login, IDLE);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="next" value={next} />
      <Field
        id="login"
        name="login"
        label={t("loginField")}
        autoComplete="username"
        required
        autoFocus
      />
      <Field
        id="password"
        name="password"
        type="password"
        label={t("password")}
        autoComplete="current-password"
        required
      />
      <FormError state={state} />
      <Submit>{t("signIn")}</Submit>
    </form>
  );
}

export function RegisterForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(register, IDLE);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="next" value={next} />
      <Field
        id="username"
        name="username"
        label={t("username")}
        hint={t("usernameHint")}
        autoComplete="username"
        pattern="[A-Za-z0-9_.]{3,30}"
        required
        autoFocus
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="first_name" name="first_name" label={t("firstName")} autoComplete="given-name" />
        <Field id="last_name" name="last_name" label={t("lastName")} autoComplete="family-name" />
      </div>
      <Field
        id="new-password"
        name="password"
        type="password"
        label={t("password")}
        hint={t("passwordHint")}
        autoComplete="new-password"
        minLength={8}
        required
      />
      <Field
        id="new-password2"
        name="password2"
        type="password"
        label={t("passwordRepeat")}
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormError state={state} />
      <Submit>{t("signUp")}</Submit>
      <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
    </form>
  );
}

export function ForgotForm() {
  const t = useTranslations("auth");
  const [state, action] = useActionState(forgotPassword, IDLE);
  if (state.status === "ok") {
    return (
      <p role="status" className="bg-accent/60 rounded-lg px-3 py-2 text-sm">
        {t("forgotSent")}
      </p>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <Field
        id="email"
        name="email"
        type="email"
        label={t("email")}
        autoComplete="email"
        required
      />
      <FormError state={state} />
      <Submit>{t("sendLink")}</Submit>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(resetPassword, IDLE);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <Field
        id="reset-password"
        name="password"
        type="password"
        label={t("newPassword")}
        hint={t("passwordHint")}
        autoComplete="new-password"
        minLength={8}
        required
      />
      <Field
        id="reset-password2"
        name="password2"
        type="password"
        label={t("passwordRepeat")}
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormError state={state} />
      <Submit>{t("savePassword")}</Submit>
    </form>
  );
}

/** Підтвердження кнопкою, а не просто відкриттям посилання: поштові сканери не «клікнуть». */
export function VerifyEmailForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(verifyEmail, IDLE);
  if (state.status === "ok") {
    return (
      <p
        role="status"
        className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300"
      >
        {t("emailVerified")}
      </p>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <FormError state={state} />
      <Submit>{t("confirmEmail")}</Submit>
    </form>
  );
}
