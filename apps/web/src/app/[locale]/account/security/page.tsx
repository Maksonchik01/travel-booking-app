import type { Account, AuthStatus, SessionInfo } from "@tickets/shared";
import { Eraser, KeyRound, LogOut, Mail, MonitorSmartphone, Send, UserRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { clearHistory, logout } from "@/app/actions/account";
import { endSession } from "@/app/actions/security";
import {
  DeleteAccountForm,
  EmailForm,
  PasswordForm,
  TelegramForm,
  UnlinkGoogleForm,
} from "@/components/account-forms";
import { AccountPage, Block, Section, Status, requireAccount } from "@/components/account-shell";
import { GoogleButton } from "@/components/google-button";
import {
  ClearBrowserData,
  ClearChatsForm,
  EndOtherSessionsForm,
} from "@/components/security-forms";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/session";

/**
 * Кабінет → «Безпека»: email, пароль, способи входу, сесії (модуль 10c), очищення
 * особистої історії, видалення акаунта.
 */
export default function SecurityPage({ searchParams }: PageProps<"/[locale]/account/security">) {
  return (
    <AccountPage section="security" searchParams={searchParams}>
      <Security />
    </AccountPage>
  );
}

async function Security() {
  const { account, token } = await requireAccount("security");
  const [status, sessions] = await Promise.all([
    call<AuthStatus>("GET", "/auth/status", undefined, null),
    call<SessionInfo[]>("GET", "/account/sessions", undefined, token),
  ]);
  return (
    <SecurityView
      account={account}
      sessions={sessions.ok ? sessions.data : []}
      google={status.ok && status.data.google}
      mailMock={status.ok && status.data.email === "mock"}
    />
  );
}

function SecurityView({
  account,
  sessions,
  google,
  mailMock,
}: {
  account: Account;
  sessions: SessionInfo[];
  google: boolean;
  mailMock: boolean;
}) {
  const t = useTranslations("account");
  return (
    <>
      <Section id="security" title={t("nav.security")}>
        <Block icon={Mail} title={t("emailTitle")}>
          {account.email ? (
            <p className="text-sm">
              {t("emailCurrent")} <span className="font-medium">{account.email}</span>
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">{t("emailNone")}</p>
          )}
          {account.pending_email && (
            <p className="text-sm text-warning">
              {t("emailPending", { email: account.pending_email })}
            </p>
          )}
          {mailMock && <p className="text-muted-foreground text-[11px]">{t("mailMock")}</p>}
          <EmailForm account={account} />
        </Block>

        <Block
          icon={KeyRound}
          title={account.has_password ? t("passwordTitle") : t("setPasswordTitle")}
        >
          {!account.has_password && (
            <p className="text-muted-foreground text-sm">{t("noPassword")}</p>
          )}
          <PasswordForm hasPassword={account.has_password} />
        </Block>

        <Block icon={UserRound} title={t("loginMethods")}>
          <ul className="grid gap-2 text-sm">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("methodPassword", { username: account.username })}</span>
              <Status on={account.has_password} />
            </li>
            <li className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Google</span>
                <Status on={account.google_linked} />
              </div>
              {account.google_linked ? (
                <UnlinkGoogleForm />
              ) : (
                <div className="max-w-xs">
                  <GoogleButton enabled={google} mode="link" />
                </div>
              )}
            </li>
            <li className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <Send className="size-3.5" aria-hidden />
                  Telegram
                </span>
                <Status on={account.telegram_linked} />
              </div>
              <TelegramForm
                key={String(account.telegram_linked)}
                linked={account.telegram_linked}
              />
            </li>
          </ul>
        </Block>

        <Block icon={MonitorSmartphone} title={t("sessions.title")}>
          <Sessions sessions={sessions} />
          <div className="flex flex-wrap items-start gap-2">
            {sessions.length > 1 && <EndOtherSessionsForm />}
            <form action={logout}>
              <input type="hidden" name="everywhere" value="1" />
              <Button type="submit" variant="outline" size="sm">
                <LogOut className="size-4" aria-hidden />
                {t("logoutEverywhere")}
              </Button>
            </form>
          </div>
        </Block>
      </Section>

      <Section id="clear" title={t("clear.title")} hint={t("clear.hint")}>
        <Block icon={Eraser} title={t("clear.what")}>
          <div className="flex flex-wrap items-start gap-2">
            <form action={clearHistory}>
              <Button type="submit" variant="outline" size="sm">
                {t("clearHistory")}
              </Button>
            </form>
            <ClearChatsForm />
            <ClearBrowserData />
          </div>
          <p className="text-muted-foreground text-xs">{t("clear.note")}</p>
        </Block>
      </Section>

      <Section id="danger" title={t("nav.danger")} hint={t("deleteHint")} tone="danger">
        <DeleteAccountForm hasPassword={account.has_password} username={account.username} />
      </Section>
    </>
  );
}

function Sessions({ sessions }: { sessions: SessionInfo[] }) {
  const t = useTranslations("account.sessions");
  const format = useFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <ul className="grid gap-2" data-testid="sessions">
      {sessions.map((s) => (
        <li
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
        >
          <span className="grid gap-0.5">
            <span className="flex items-center gap-2 font-medium">
              {s.device ?? t("unknownDevice")}
              {s.current && (
                <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[11px]">
                  {t("current")}
                </span>
              )}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("since", { date: when(s.created_at) })}
              {s.last_seen_at && <> · {t("seen", { date: when(s.last_seen_at) })}</>}
            </span>
          </span>
          <form action={endSession}>
            <input type="hidden" name="id" value={s.id} />
            {s.current && <input type="hidden" name="current" value="1" />}
            <Button type="submit" variant="ghost" size="sm">
              {s.current ? t("signOut") : t("end")}
            </Button>
          </form>
        </li>
      ))}
    </ul>
  );
}
