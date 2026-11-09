"use client";

import type { Account } from "@tickets/shared";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import type { FormState } from "@/app/actions/account";
import { clearServerChats, endOtherSessions, saveNotifyPrefs } from "@/app/actions/security";
import { FormError, Submit } from "@/components/auth-forms";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CHAT_STORAGE_KEY } from "@/lib/chat-history";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";

const IDLE: FormState = { status: "idle" };
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Тема — налаштування, а не історія: її не чистимо. */
const KEEP_KEYS = new Set(["tickets.theme"]);

function Done({ state, text }: { state: FormState; text: string }) {
  if (state.status !== "ok") return null;
  return (
    <p role="status" className="text-sm text-success">
      {text}
    </p>
  );
}

function Check({
  name,
  value = "1",
  checked,
  disabled,
  children,
}: {
  name: string;
  value?: string;
  checked: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={checked}
        disabled={disabled}
        className="accent-primary mt-0.5 size-4"
      />
      <span className="grid gap-0.5">{children}</span>
    </label>
  );
}

function Select({
  id,
  label,
  children,
  ...props
}: React.ComponentProps<"select"> & { id: string; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </Label>
      <select id={id} className={SELECT_CLASS} {...props}>
        {children}
      </select>
    </div>
  );
}

/**
 * Налаштування сповіщень (10.8). Діють на підписки, створені з акаунтом; перевіряє їх воркер
 * перед кожним надсиланням. Пояс для тихих годин — з браузера.
 */
export function NotifyPrefsForm({ account }: { account: Account }) {
  const t = useTranslations("account.notify");
  const hydrated = useHydrated();
  const [state, action] = useActionState(saveNotifyPrefs, IDLE);
  const p = account.notify_prefs;
  const muted = p?.muted ?? [];
  const browserZone = hydrated ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const zone = browserZone ?? p?.timezone ?? "";
  const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

  return (
    <form action={action} className="grid gap-5" data-testid="notify-form">
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t("channels")}</legend>
        <Check name="email" checked={p?.email ?? true}>
          {t("email")}
        </Check>
        <Check name="telegram" checked={p?.telegram ?? true}>
          {t("telegram")}
          {!account.telegram_linked && (
            <span className="text-muted-foreground text-xs">{t("telegramNotLinked")}</span>
          )}
        </Check>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t("categories")}</legend>
        <Check name="category" value="below_price" checked={!muted.includes("below_price")}>
          {t("belowPrice")}
        </Check>
        <Check name="category" value="below_typical" checked={!muted.includes("below_typical")}>
          {t("belowTypical")}
        </Check>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          id="np-interval"
          name="interval"
          label={t("frequency")}
          defaultValue={String(p?.min_interval_hours ?? 24)}
        >
          {[24, 72, 168].map((h) => (
            <option key={h} value={h}>
              {t(`interval.${h}`)}
            </option>
          ))}
        </Select>
        <Select
          id="np-drop"
          name="drop"
          label={t("minDrop")}
          defaultValue={String(p?.min_drop_percent ?? 0)}
        >
          {[0, 3, 5, 10].map((d) => (
            <option key={d} value={d}>
              {d ? t("dropPercent", { percent: d }) : t("anyDrop")}
            </option>
          ))}
        </Select>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t("quiet")}</legend>
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <Select
            id="np-quiet-start"
            name="quiet_start"
            label={t("quietFrom")}
            defaultValue={p?.quiet_start != null ? String(p.quiet_start) : ""}
          >
            <option value="">—</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </Select>
          <Select
            id="np-quiet-end"
            name="quiet_end"
            label={t("quietTo")}
            defaultValue={p?.quiet_end != null ? String(p.quiet_end) : ""}
          >
            <option value="">—</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </Select>
        </div>
        <input type="hidden" name="timezone" value={zone} />
        <p className="text-muted-foreground text-xs">{t("quietHint", { zone: zone || "UTC" })}</p>
      </fieldset>

      <p className="text-muted-foreground text-xs">{t("scope")}</p>
      <FormError state={state} />
      <Done state={state} text={t("saved")} />
      <Submit className="justify-self-start">{t("save")}</Submit>
    </form>
  );
}

export function EndOtherSessionsForm() {
  const t = useTranslations("account.sessions");
  const [state, action] = useActionState(endOtherSessions, IDLE);
  return (
    <form action={action} className="grid gap-2">
      <Button type="submit" variant="outline" size="sm" className="justify-self-start">
        {t("endOthers")}
      </Button>
      <FormError state={state} />
      <Done state={state} text={t("endedOthers")} />
    </form>
  );
}

/**
 * Розмови з помічником: на сервері (якщо була синхронізація) і в цьому браузері. Без
 * очищення браузера синхронізація повернула б їх з localStorage на сервер.
 */
export function ClearChatsForm() {
  const t = useTranslations("account.clear");
  const hydrated = useHydrated();
  const [state, action] = useActionState(async (prev: FormState) => {
    const result = await clearServerChats();
    if (result.status === "ok") {
      try {
        localStorage.removeItem(CHAT_STORAGE_KEY);
      } catch {
        // сховище браузера недоступне — на сервері вже очищено
      }
    }
    return result.status === "ok" ? result : { ...prev, ...result };
  }, IDLE);
  return (
    <form action={action} className="grid gap-2">
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={!hydrated}
      >
        {t("chats")}
      </Button>
      <FormError state={state} />
      <Done state={state} text={t("chatsDone")} />
    </form>
  );
}

/** Дані SkyPack у цьому браузері: історія чатів, обране й поїздки гостя, порівняння тощо. */
export function ClearBrowserData() {
  const t = useTranslations("account.clear");
  const hydrated = useHydrated();
  const [done, setDone] = useState(false);
  function clear() {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        for (const key of Object.keys(storage)) {
          if (key.startsWith("tickets.") && !KEEP_KEYS.has(key)) storage.removeItem(key);
        }
      } catch {
        // приватний режим чи заблоковане сховище — чистити нічого
      }
    }
    setDone(true);
  }
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={!hydrated}
        onClick={clear}
        data-testid="clear-browser"
      >
        {t("browser")}
      </Button>
      {done && (
        <p role="status" className="text-sm text-success">
          {t("browserDone")}
        </p>
      )}
    </div>
  );
}
