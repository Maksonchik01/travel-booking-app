"use client";

import { track } from "@/lib/analytics";
import type {
  AlertChannel,
  AlertCondition,
  AlertCreate,
  AlertCreated,
  ChannelStatus,
} from "@tickets/shared";
import { Bell, BellOff, BellRing, Loader2, Mail, Send, X } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { isLocale } from "@/i18n/config";
import type { AlertKind, AlertTarget } from "@/lib/alerts";
import { FIELD_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/client-fetch";

/** Підписки, створені в цьому браузері: маршрут → токен керування (лише локально). */
const WATCHED_KEY = "tickets.alerts.v1";

const PERCENTS = [5, 10, 15, 20, 30] as const;

type Props = {
  target: AlertTarget;
  /** Найкраща ціна зараз (за всіх) — від неї пропонуємо поріг. */
  bestPrice: number | null;
  channels: ChannelStatus;
  /** Підміна мережі в тестах. */
  create?: (body: AlertCreate) => Promise<AlertCreated | null>;
};

/** Причини відмови з API (код у `detail`) — UI пояснює їх своєю мовою (модуль 18.1). */
const ERROR_CODES = [
  "past_date",
  "kind_unavailable",
  "too_far",
  "closed",
  "owner_limit",
  "invalid",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number] | "error";

class CreateFailed extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

async function createViaApi(body: AlertCreate): Promise<AlertCreated | null> {
  const response = await fetchWithTimeout("/api/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return (await response.json()) as AlertCreated;
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  throw new CreateFailed(ERROR_CODES.find((c) => c === data?.error) ?? "error");
}

function readWatched(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(WATCHED_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(key: string, token: string) {
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify({ ...readWatched(), [key]: token }));
  } catch {
    // без сховища позначки «стежите» не буде — підписка від цього не залежить
  }
}

/** Ціна на 10% нижча за поточну, округлена вниз — розумний поріг за замовчуванням. */
function suggestedThreshold(best: number | null): number {
  return best ? Math.max(1, Math.floor(best * 0.9)) : 100;
}

/** Зниження на суму за замовчуванням — 10% від поточної ціни (щонайменше 5). */
function suggestedDrop(best: number | null): number {
  return best ? Math.max(5, Math.round(best * 0.1)) : 20;
}

/**
 * «Стежити за ціною»: підписка з умовою й каналом. Без акаунта — підтвердження
 * в Telegram (/start) чи листом; керування — за посиланням з токеном. Тип, якого зараз
 * не можна створити (житло без реального джерела), — неактивна кнопка з поясненням.
 */
export function PriceAlert(props: Props) {
  if (!props.channels.kinds?.includes(props.target.kind)) {
    return <AlertUnavailable kind={props.target.kind} />;
  }
  return <AvailableAlert {...props} />;
}

function AvailableAlert(props: Props) {
  const hydrated = useHydrated();
  // До гідратації localStorage недоступний — показуємо кнопку, потім позначку «стежите».
  return <AlertPanel key={hydrated ? "client" : "server"} restored={hydrated} {...props} />;
}

function AlertPanel({
  target,
  bestPrice,
  channels,
  create = createViaApi,
  restored,
}: Props & { restored: boolean }) {
  const t = useTranslations("alerts");
  const [open, setOpen] = useState(false);
  const [watchToken, setWatchToken] = useState(() =>
    restored ? (readWatched()[target.key] ?? null) : null,
  );
  const [condition, setCondition] = useState<AlertCondition>("below_price");
  const [threshold, setThreshold] = useState(String(suggestedThreshold(bestPrice)));
  const [amount, setAmount] = useState(String(suggestedDrop(bestPrice)));
  const [percent, setPercent] = useState<number>(10);
  const [weekends, setWeekends] = useState(false);
  const currency = target.base.currency ?? "EUR";
  const [channel, setChannel] = useState<AlertChannel>("telegram");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<AlertCreated | null>(null);
  const [failed, setFailed] = useState<ErrorCode | null>(null);
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailed(null);
    startTransition(async () => {
      let result: AlertCreated | null;
      try {
        result = await create({
          ...target.base,
          weekends: target.kind === "flex" && weekends,
          condition,
          threshold:
            condition === "below_price"
              ? Number(threshold)
              : condition === "drop_amount"
                ? Number(amount)
                : null,
          percent: condition === "drop_percent" ? percent : null,
          channel,
          email: channel === "email" ? email.trim() : null,
          // Листи й повідомлення підписки — мовою інтерфейсу (модуль 18.1).
          locale: isLocale(locale) ? locale : null,
        });
      } catch (error) {
        setFailed(error instanceof CreateFailed ? error.code : "error");
        return;
      }
      if (!result) {
        setFailed("error");
        return;
      }
      if (!result.existing) track("alert_created", { kind: target.kind });
      remember(target.key, result.manage_token);
      setCreated(result);
      setWatchToken(result.manage_token);
    });
  }

  if (!open && watchToken) {
    return (
      <Link
        href={`/alerts?token=${watchToken}`}
        className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
      >
        <BellRing className="size-4" aria-hidden />
        {t("watching")}
      </Link>
    );
  }
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        // До гідратації клік загубився б (а панель ще й перемонтується) — кнопка неактивна.
        disabled={!restored}
        className="bg-card hover:border-primary/50 hover:text-primary w-fit rounded-full shadow-xs"
      >
        <Bell className="size-4" aria-hidden />
        {t("watch")}
      </Button>
    );
  }

  return (
    <section
      aria-labelledby="price-alert-title"
      className="bg-card animate-in fade-in-0 slide-in-from-top-1 grid gap-4 rounded-xl border p-4 shadow-sm duration-200"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 id="price-alert-title" className="flex items-center gap-2 font-semibold">
            <Bell className="text-primary size-4" aria-hidden />
            {target.kind === "stay"
              ? t("titleStay", { city: target.title.to })
              : t("title", target.title)}
          </h2>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("close")}
          className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-8 place-items-center rounded-md transition-colors"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {created ? (
        <Created created={created} channels={channels} />
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <fieldset className="grid gap-2 text-sm">
            <legend className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
              {t("condition")}
            </legend>
            <ConditionRow value="below_price" current={condition} onPick={setCondition}>
              {t("belowPrice")}
              <AmountInput
                label={t("threshold", { currency })}
                value={threshold}
                onChange={setThreshold}
                active={condition === "below_price"}
              />
              <span className="text-muted-foreground">{t("forAll", { currency })}</span>
            </ConditionRow>
            <ConditionRow value="drop_amount" current={condition} onPick={setCondition}>
              {t("dropAmount")}
              <AmountInput
                label={t("dropAmountLabel", { currency })}
                value={amount}
                onChange={setAmount}
                active={condition === "drop_amount"}
              />
              <span className="text-muted-foreground">{currency}</span>
            </ConditionRow>
            <ConditionRow value="drop_percent" current={condition} onPick={setCondition}>
              {t("dropPercent")}
              <select
                aria-label={t("dropPercentLabel")}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                disabled={condition !== "drop_percent"}
                className={cn(FIELD_CLASS, "border-input h-9 w-20 border px-2 text-sm")}
              >
                {PERCENTS.map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
            </ConditionRow>
            {target.kind === "flight" && (
              <ConditionRow value="below_typical" current={condition} onPick={setCondition}>
                {t("belowTypical")}
              </ConditionRow>
            )}
            <p className="text-muted-foreground text-xs">{t("dropHint")}</p>
          </fieldset>

          {target.kind === "flex" && (
            <div className="grid gap-1 text-sm">
              <p className="text-muted-foreground text-xs">
                {t("flexSummary", {
                  from: target.base.departure_date,
                  until: target.base.departure_until ?? "",
                  min: target.base.min_nights ?? 1,
                  max: target.base.max_nights ?? target.base.min_nights ?? 1,
                })}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={weekends}
                  onChange={(e) => setWeekends(e.target.checked)}
                  className="accent-primary size-4"
                />
                {t("weekends")}
              </label>
            </div>
          )}
          {target.base.baggage && target.base.baggage !== "none" && (
            <p className="text-muted-foreground text-xs">{t("baggageNote")}</p>
          )}
          {/* Умови з пошуку (етап 6): підписка стежить саме за ними. */}
          {(target.base.direct_only || target.base.min_rating) && (
            <p className="text-muted-foreground text-xs" data-testid="alert-search-conditions">
              {[
                target.base.direct_only ? t("directOnly") : null,
                target.base.min_rating ? t("minRating", { rating: target.base.min_rating }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          <fieldset className="grid gap-2 text-sm">
            <legend className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
              {t("channel")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {(["telegram", "email"] as const).map((c) => {
                const Icon = c === "telegram" ? Send : Mail;
                return (
                  <label
                    key={c}
                    className="has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-accent-foreground hover:border-primary/50 has-[:focus-visible]:ring-ring/50 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors has-[:focus-visible]:ring-[3px]"
                  >
                    <input
                      type="radio"
                      name="channel"
                      checked={channel === c}
                      onChange={() => setChannel(c)}
                      className="sr-only"
                    />
                    <Icon className="size-4" aria-hidden />
                    {t(`channels.${c}`)}
                    {channels[c] === "mock" && (
                      <span className="text-muted-foreground text-[11px]">{t("mock")}</span>
                    )}
                  </label>
                );
              })}
            </div>
            {channel === "email" && (
              <input
                type="email"
                required
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                aria-label={t("email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={cn(FIELD_CLASS, "border-input w-full max-w-sm border px-3 text-sm")}
              />
            )}
          </fieldset>

          {failed && (
            <p role="alert" className="text-sm text-warning" data-testid="alert-error">
              {failed === "error" ? t("error") : t(`errors.${failed}`)}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground max-w-md text-[11px]">{t("privacy")}</p>
            <Button type="submit" disabled={pending} className="shadow-primary/25 shadow-md">
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <BellRing className="size-4" aria-hidden />
              )}
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function Created({ created, channels }: { created: AlertCreated; channels: ChannelStatus }) {
  const t = useTranslations("alerts");
  return (
    <div role="status" className="grid gap-3 text-sm">
      {created.existing ? (
        <p>{t("existing")}</p>
      ) : created.channel === "telegram" && created.telegram_link ? (
        <>
          <p>{t("telegramNext")}</p>
          <a
            href={created.telegram_link}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-fit items-center gap-2 rounded-lg px-4 py-2 font-medium shadow-md transition-colors"
          >
            <Send className="size-4" aria-hidden />
            {t("openTelegram", { bot: channels.bot_username ?? "bot" })}
          </a>
        </>
      ) : (
        <p>{t("emailNext")}</p>
      )}
      <Link
        href={`/alerts?token=${created.manage_token}`}
        className="text-primary w-fit text-xs font-medium underline-offset-4 hover:underline"
      >
        {t("manage")}
      </Link>
    </div>
  );
}

function ConditionRow({
  value,
  current,
  onPick,
  children,
}: {
  value: AlertCondition;
  current: AlertCondition;
  onPick: (value: AlertCondition) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <input
        type="radio"
        name="condition"
        checked={current === value}
        onChange={() => onPick(value)}
        className="size-4"
      />
      {children}
    </label>
  );
}

function AmountInput({
  label,
  value,
  onChange,
  active,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  active: boolean;
}) {
  return (
    <input
      type="number"
      min={1}
      step={1}
      inputMode="numeric"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!active}
      required={active}
      className={cn(FIELD_CLASS, "border-input h-9 w-24 border px-2 text-sm")}
    />
  );
}

/** Тип підписки поки недоступний (житло й поїздка — без реального джерела житла, ТЗ 11.4). */
export function AlertUnavailable({ kind }: { kind: AlertKind | "party" }) {
  const t = useTranslations("alerts");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="alert-unavailable">
      <Button type="button" variant="outline" disabled className="w-fit rounded-full">
        <BellOff className="size-4" aria-hidden />
        {t("watch")}
      </Button>
      <span className="text-muted-foreground text-xs">{t(`unavailable.${kind}`)}</span>
    </div>
  );
}
