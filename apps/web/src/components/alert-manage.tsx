import type { AlertEventOut, AlertView } from "@tickets/shared";
import {
  Bell,
  BellOff,
  CheckCircle2,
  Clock,
  History,
  Pause,
  Pencil,
  Plane,
  Play,
  Send,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { alertSearchHref } from "@/lib/alerts";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

/** Куди повернутися після дії: сторінка за посиланням чи кабінет. */
export type AlertBack = "link" | "account";

const STATUS_TONE: Record<AlertView["status"], string> = {
  active: "bg-success/10 text-success",
  pending: "bg-warning/10 text-warning",
  paused: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  stopped: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
};
const BAGGAGE = ["none", "personal_item", "carry_on", "checked", "checked_extra"] as const;
const PERCENTS = [5, 10, 15, 20, 30] as const;

/**
 * Підписка на ціну (модуль 11.3): умови, остання перевірена ціна й час, статус, історія
 * спрацювань; призупинити, відновити, редагувати, вимкнути, видалити. Звичайні форми — працює
 * й без JS (маршрути `/api/alerts/action` і `/api/alerts/edit`).
 */
export function AlertManage({
  alert,
  token,
  history,
  back,
  telegramLink = null,
  heading = "h2",
}: {
  alert: AlertView;
  token: string;
  history: AlertEventOut[];
  back: AlertBack;
  telegramLink?: string | null;
  heading?: "h1" | "h2";
}) {
  const t = useTranslations("alertPage");
  const format = useFormatter();
  const money = (v: number) =>
    format.number(v, {
      style: "currency",
      currency: alert.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(v),
    });
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const Heading = heading;
  const editable =
    alert.status === "active" || alert.status === "pending" || alert.status === "paused";

  return (
    <div className="grid gap-4" data-testid="alert-manage">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <Heading className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {alert.kind === "stay" ? (
              t("stayTitle", { city: alert.destination })
            ) : (
              <>
                {alert.origin}
                <Plane className="text-primary size-4" aria-hidden />
                {alert.destination}
              </>
            )}
          </Heading>
          <p className="text-muted-foreground text-sm">
            {t(`kinds.${alert.kind}`)} ·{" "}
            {alert.kind === "flex" && alert.departure_until
              ? t("flexDates", {
                  from: date(alert.departure_date),
                  until: date(alert.departure_until),
                  min: alert.min_nights ?? 1,
                  max: alert.max_nights ?? alert.min_nights ?? 1,
                })
              : alert.return_date
                ? `${date(alert.departure_date)} – ${date(alert.return_date)}`
                : date(alert.departure_date)}
            {alert.weekends && ` · ${t("weekends")}`} · {t("adults", { count: alert.adults })}
            {alert.baggage && alert.baggage !== "none" && ` · ${t(`baggage.${alert.baggage}`)}`}
          </p>
        </div>
        <span
          className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[alert.status])}
        >
          {t(`statuses.${alert.status}`)}
        </span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("condition")}</dt>
        <dd>
          {alert.condition === "below_price" && alert.threshold != null
            ? t("belowPrice", { price: money(alert.threshold) })
            : alert.condition === "drop_amount" && alert.threshold != null
              ? t("dropAmount", { amount: money(alert.threshold) })
              : alert.condition === "drop_percent" && alert.percent != null
                ? t("dropPercent", { percent: alert.percent })
                : t("belowTypical")}
          {alert.baseline_price != null && alert.condition.startsWith("drop") && (
            <span className="text-muted-foreground">
              {" "}
              · {t("baseline", { price: money(alert.baseline_price) })}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("channel")}</dt>
        <dd>{t(`channels.${alert.channel}`)}</dd>
        <dt className="text-muted-foreground">{t("lastCheck")}</dt>
        <dd className="flex items-center gap-1.5">
          <Clock className="text-muted-foreground size-3.5" aria-hidden />
          {alert.last_checked_at
            ? t("lastCheckValue", {
                when: when(alert.last_checked_at),
                price: alert.last_price != null ? money(alert.last_price) : "—",
              })
            : t("notChecked")}
        </dd>
        {alert.last_notified_price != null && (
          <>
            <dt className="text-muted-foreground">{t("lastNotified")}</dt>
            <dd>
              {money(alert.last_notified_price)}
              {alert.last_notified_at && (
                <span className="text-muted-foreground"> · {when(alert.last_notified_at)}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {telegramLink && (
        <div className="bg-accent/60 grid gap-2 rounded-lg p-3 text-sm">
          <p>{t("telegramPending")}</p>
          <a
            href={telegramLink}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-fit items-center gap-2 rounded-lg px-4 py-2 font-medium transition-colors"
          >
            <Send className="size-4" aria-hidden />
            {t("openTelegram")}
          </a>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Link
          href={alertSearchHref(alert)}
          className="text-primary mr-auto text-sm font-medium underline-offset-4 hover:underline"
        >
          {t(alert.kind === "stay" ? "openStays" : "openSearch")}
        </Link>
        {alert.channel === "email" && alert.status === "pending" && (
          <ActionForm token={token} back={back} action="confirm">
            <Button type="submit" size="sm" className="shadow-primary/25 shadow-md">
              <CheckCircle2 className="size-4" aria-hidden />
              {t("confirm")}
            </Button>
          </ActionForm>
        )}
        {alert.status === "active" && (
          <ActionForm token={token} back={back} action="pause">
            <Button type="submit" size="sm" variant="outline">
              <Pause className="size-4" aria-hidden />
              {t("pause")}
            </Button>
          </ActionForm>
        )}
        {alert.status === "paused" && (
          <ActionForm token={token} back={back} action="resume">
            <Button type="submit" size="sm" variant="outline">
              <Play className="size-4" aria-hidden />
              {t("resume")}
            </Button>
          </ActionForm>
        )}
        {editable && (
          <ActionForm token={token} back={back} action="stop">
            <Button type="submit" size="sm" variant="outline">
              <BellOff className="size-4" aria-hidden />
              {t("stop")}
            </Button>
          </ActionForm>
        )}
        <ActionForm token={token} back={back} action="delete">
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            className="hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-4" aria-hidden />
            {t("delete")}
          </Button>
        </ActionForm>
      </div>

      {editable && <EditForm alert={alert} token={token} back={back} />}
      <HistoryList history={history} money={money} when={when} />
    </div>
  );
}

function ActionForm({
  token,
  back,
  action,
  children,
}: {
  token: string;
  back: AlertBack;
  action: "confirm" | "stop" | "pause" | "resume" | "delete";
  children: React.ReactNode;
}) {
  return (
    <form method="post" action="/api/alerts/action">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Редагування: дати, люди, багаж, умова. Маршрут, тип і канал — лише новою підпискою. */
function EditForm({ alert, token, back }: { alert: AlertView; token: string; back: AlertBack }) {
  const t = useTranslations("alertPage");
  const input = cn(FIELD_CLASS, "border-input h-10 w-full border px-3 text-sm");
  const flex = alert.kind === "flex";
  const stay = alert.kind === "stay";
  return (
    <details className="group rounded-lg border p-3" data-testid="alert-edit">
      <summary className="hover:text-primary flex cursor-pointer items-center gap-2 text-sm font-medium select-none">
        <Pencil className="size-4" aria-hidden />
        {t("edit")}
      </summary>
      <form method="post" action="/api/alerts/edit" className="mt-3 grid gap-3">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="back" value={back} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t(stay ? "checkIn" : flex ? "periodFrom" : "departure")}>
            <input
              type="date"
              name="departure_date"
              required
              defaultValue={alert.departure_date}
              className={input}
            />
          </Field>
          {flex ? (
            <Field label={t("periodUntil")}>
              <input
                type="date"
                name="departure_until"
                required
                defaultValue={alert.departure_until ?? ""}
                className={input}
              />
            </Field>
          ) : (
            <Field label={t(stay ? "checkOut" : "returnDate")}>
              <input
                type="date"
                name="return_date"
                required={stay}
                defaultValue={alert.return_date ?? ""}
                className={input}
              />
            </Field>
          )}
          {flex && (
            <>
              <Field label={t("nightsFrom")}>
                <input
                  type="number"
                  name="min_nights"
                  min={1}
                  max={30}
                  required
                  defaultValue={alert.min_nights ?? 1}
                  className={input}
                />
              </Field>
              <Field label={t("nightsTo")}>
                <input
                  type="number"
                  name="max_nights"
                  min={1}
                  max={30}
                  defaultValue={alert.max_nights ?? alert.min_nights ?? 1}
                  className={input}
                />
              </Field>
            </>
          )}
          <Field label={t("adultsLabel")}>
            <select name="adults" defaultValue={alert.adults} className={SELECT_CLASS}>
              {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          {!stay && (
            <Field label={t("baggageLabel")}>
              <select
                name="baggage"
                defaultValue={alert.baggage ?? "none"}
                className={SELECT_CLASS}
              >
                {BAGGAGE.map((b) => (
                  <option key={b} value={b}>
                    {t(`baggage.${b}`)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {flex && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="weekends"
              value="1"
              defaultChecked={alert.weekends}
              className="accent-primary size-4"
            />
            {t("weekendsLabel")}
          </label>
        )}
        {/* Умови пошуку (етап 6): «лише прямі» — переліт і поїздка; рейтинг — житло й поїздка. */}
        {!stay && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="direct_only"
              value="1"
              defaultChecked={alert.direct_only ?? false}
              className="accent-primary size-4"
            />
            {t("directLabel")}
          </label>
        )}
        {(stay || alert.kind === "trip") && (
          <Field label={t("ratingLabel")}>
            <select
              name="min_rating"
              defaultValue={alert.min_rating ?? ""}
              className={SELECT_CLASS}
            >
              <option value="">{t("anyRating")}</option>
              {[7, 8, 9].map((r) => (
                <option key={r} value={r}>
                  {t("ratingFrom", { rating: r })}
                </option>
              ))}
            </select>
          </Field>
        )}
        <fieldset className="grid gap-2 text-sm">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">
            {t("condition")}
          </legend>
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="condition"
              value="below_price"
              defaultChecked={alert.condition === "below_price"}
              className="size-4"
            />
            {t("editBelowPrice")}
            <input
              type="number"
              name="threshold_price"
              min={1}
              aria-label={t("thresholdLabel", { currency: alert.currency })}
              defaultValue={alert.condition === "below_price" ? (alert.threshold ?? "") : ""}
              className={cn(input, "h-9 w-24")}
            />
            <span className="text-muted-foreground">{alert.currency}</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="condition"
              value="drop_amount"
              defaultChecked={alert.condition === "drop_amount"}
              className="size-4"
            />
            {t("editDropAmount")}
            <input
              type="number"
              name="threshold_drop"
              min={1}
              aria-label={t("dropAmountLabel", { currency: alert.currency })}
              defaultValue={alert.condition === "drop_amount" ? (alert.threshold ?? "") : ""}
              className={cn(input, "h-9 w-24")}
            />
            <span className="text-muted-foreground">{alert.currency}</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="condition"
              value="drop_percent"
              defaultChecked={alert.condition === "drop_percent"}
              className="size-4"
            />
            {t("editDropPercent")}
            <select
              name="percent"
              aria-label={t("percentLabel")}
              defaultValue={alert.percent ?? 10}
              className={cn(SELECT_CLASS, "h-9 w-20")}
            >
              {PERCENTS.map((p) => (
                <option key={p} value={p}>
                  {p}%
                </option>
              ))}
            </select>
          </label>
          {alert.kind === "flight" && (
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="condition"
                value="below_typical"
                defaultChecked={alert.condition === "below_typical"}
                className="size-4"
              />
              {t("belowTypical")}
            </label>
          )}
        </fieldset>
        <p className="text-muted-foreground text-xs">{t("editHint")}</p>
        <Button type="submit" size="sm" className="justify-self-start">
          {t("saveEdit")}
        </Button>
      </form>
    </details>
  );
}

function HistoryList({
  history,
  money,
  when,
}: {
  history: AlertEventOut[];
  money: (v: number) => string;
  when: (iso: string) => string;
}) {
  const t = useTranslations("alertPage");
  const notified = history.filter((e) => e.kind === "notified").length;
  return (
    <details className="rounded-lg border p-3" data-testid="alert-history">
      <summary className="hover:text-primary flex cursor-pointer items-center gap-2 text-sm font-medium select-none">
        <History className="size-4" aria-hidden />
        {t("history", { count: notified })}
      </summary>
      {history.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">{t("historyEmpty")}</p>
      ) : (
        <ol className="mt-2 grid gap-1.5 text-sm">
          {history.map((e, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground w-28 shrink-0 text-xs tabular-nums">
                {when(e.created_at)}
              </span>
              <span className={cn(e.kind === "notified" && "font-medium")}>
                {e.kind === "notified" && (
                  <Bell className="text-primary mr-1 inline size-3.5" aria-hidden />
                )}
                {t(`events.${e.kind}`)}
                {e.price != null && ` · ${money(e.price)}`}
                {e.kind === "held" && e.detail && ` · ${t(`held.${e.detail}`)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
