"use client";

import type { Account } from "@tickets/shared";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import {
  changeEmail,
  changePassword,
  deleteAccount,
  type FormState,
  renameSearch,
  linkTelegram,
  unlinkGoogle,
  unlinkTelegram,
  updateProfile,
} from "@/app/actions/account";
import { Field, FormError, Submit } from "@/components/auth-forms";
import { Button } from "@/components/ui/button";

const IDLE: FormState = { status: "idle" };

function Saved({ state, text }: { state: FormState; text: string }) {
  if (state.status !== "ok") return null;
  return (
    <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
      {text}
    </p>
  );
}

export function ProfileForm({ account }: { account: Account }) {
  const t = useTranslations("account");
  const tAuth = useTranslations("auth");
  const [state, action] = useActionState(updateProfile, IDLE);
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="first_name"
          name="first_name"
          label={tAuth("firstName")}
          defaultValue={account.first_name ?? ""}
          maxLength={60}
          autoComplete="given-name"
        />
        <Field
          id="last_name"
          name="last_name"
          label={tAuth("lastName")}
          defaultValue={account.last_name ?? ""}
          maxLength={60}
          autoComplete="family-name"
        />
      </div>
      <FormError state={state} />
      <Saved state={state} text={t("saved")} />
      <Submit className="justify-self-start">{t("save")}</Submit>
    </form>
  );
}

export function EmailForm({ account }: { account: Account }) {
  const t = useTranslations("account");
  const [state, action] = useActionState(changeEmail, IDLE);
  return (
    <form action={action} className="grid gap-3">
      <Field
        id="email"
        name="email"
        type="email"
        label={account.email ? t("newEmail") : t("email")}
        autoComplete="email"
        required
      />
      <FormError state={state} />
      <Saved state={state} text={t("emailSent")} />
      <Submit className="justify-self-start">{t("sendConfirmation")}</Submit>
    </form>
  );
}

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("account");
  const tAuth = useTranslations("auth");
  const [state, action] = useActionState(changePassword, IDLE);
  return (
    <form action={action} className="grid gap-3">
      {hasPassword && (
        <Field
          id="current"
          name="current"
          type="password"
          label={t("currentPassword")}
          autoComplete="current-password"
          required
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="account-password"
          name="password"
          type="password"
          label={tAuth("newPassword")}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <Field
          id="account-password2"
          name="password2"
          type="password"
          label={tAuth("passwordRepeat")}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      <p className="text-muted-foreground text-[11px]">{t("passwordNote")}</p>
      <FormError state={state} />
      <Saved state={state} text={t("passwordSaved")} />
      <Submit className="justify-self-start">
        {hasPassword ? t("changePassword") : t("setPassword")}
      </Submit>
    </form>
  );
}

export function UnlinkGoogleForm() {
  const t = useTranslations("account");
  const [state, action] = useActionState(unlinkGoogle, IDLE);
  return (
    <form action={action} className="grid gap-2">
      <FormError state={state} />
      <Button type="submit" variant="outline" size="sm" className="justify-self-start">
        {t("unlink")}
      </Button>
    </form>
  );
}

export function TelegramForm({ linked }: { linked: boolean }) {
  const t = useTranslations("account");
  const [state, action] = useActionState(linked ? unlinkTelegram : linkTelegram, IDLE);
  return (
    <form action={action} className="grid gap-2">
      {!linked && <p className="text-muted-foreground text-xs">{t("telegramHint")}</p>}
      <FormError state={state} />
      <Button type="submit" variant="outline" size="sm" className="justify-self-start">
        {linked ? t("unlinkTelegram") : t("linkTelegram")}
      </Button>
    </form>
  );
}

export function RenameForm({ id, title }: { id: string; title: string }) {
  const t = useTranslations("account");
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(renameSearch, IDLE);
  if (!open || state.status === "ok") {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("rename")}
        title={t("rename")}
        className="text-muted-foreground hover:text-primary hover:bg-accent grid size-8 place-items-center rounded-md transition-colors"
      >
        <Pencil className="size-4" aria-hidden />
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input
        name="title"
        defaultValue={title}
        maxLength={120}
        required
        autoFocus
        aria-label={t("title")}
        className="border-input bg-card h-8 rounded-md border px-2 text-sm"
      />
      <Button type="submit" size="sm">
        {t("save")}
      </Button>
    </form>
  );
}

export function DeleteAccountForm({
  hasPassword,
  username,
}: {
  hasPassword: boolean;
  username: string;
}) {
  const t = useTranslations("account");
  const [state, action] = useActionState(deleteAccount, IDLE);
  return (
    <form action={action} className="grid gap-3">
      <Field
        id="confirm"
        name="confirm"
        type={hasPassword ? "password" : "text"}
        label={hasPassword ? t("deleteConfirmPassword") : t("deleteConfirmUsername", { username })}
        autoComplete={hasPassword ? "current-password" : "off"}
        required
      />
      <FormError state={state} />
      <Button type="submit" variant="destructive" className="justify-self-start">
        {t("deleteAccount")}
      </Button>
    </form>
  );
}
