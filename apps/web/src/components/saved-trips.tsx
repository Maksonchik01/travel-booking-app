"use client";

import type {
  SavedTrip,
  SavedTripBody,
  SavedTripPatch,
  TripRefresh,
  TripStatus,
} from "@tickets/shared";
import {
  Bell,
  BookmarkCheck,
  BookmarkPlus,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState } from "react";

import {
  createSavedTrip,
  deleteSavedTrip,
  loadSavedTrips,
  patchSavedTrip,
  updateSavedTrip,
} from "@/app/actions/saved-trips";
import { TripCompareToggle } from "@/components/trip-compare";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { localTime } from "@/lib/format";
import {
  MAX_SAVED_TRIPS,
  TRIP_STATUSES,
  readLocalTrips,
  type SavedTripItem,
  savedBody,
  writeLocalTrips,
} from "@/lib/saved-trips";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { toTripParams } from "@/lib/trip-params";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type SavedTrips = {
  /** null — ще завантажується. */
  signedIn: boolean | null;
  items: SavedTripItem[];
  error: string | null;
  /** Нова поїздка (і «Створити копію»); повертає id або null. */
  create: (body: SavedTripBody) => Promise<string | null>;
  update: (id: string, body: SavedTripBody) => Promise<boolean>;
  /** Назва чи статус — без зміни конфігурації й знімка. */
  patch: (id: string, patch: SavedTripPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const SavedTripsContext = createContext<SavedTrips | null>(null);

/**
 * Зберегти поїздку поза сторінкою «Мої поїздки» (з чату, модуль 9a): з акаунтом — у профіль,
 * інакше в цьому браузері. false — не вдалося (ліміт чи помилка).
 */
export async function saveTripNow(body: SavedTripBody): Promise<boolean> {
  const state = await createSavedTrip(body).catch(() => null);
  if (state?.signedIn) return state.ok;
  const items = readLocalTrips();
  if (items.length >= MAX_SAVED_TRIPS) return false;
  const now = new Date().toISOString();
  const id = `local-${crypto.randomUUID().replaceAll("-", "")}`;
  writeLocalTrips([{ id, created_at: now, updated_at: now, ...body }, ...items]);
  return true;
}

const fromAccount = (items: SavedTrip[]): SavedTripItem[] =>
  items.map((t) => ({ ...t, query: t.query as SavedTripItem["query"] }));

/** «Мої поїздки» (модуль 8c): з акаунтом — у профілі, без нього — у цьому браузері. */
export function SavedTripsProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [items, setItems] = useState<SavedTripItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const local = readLocalTrips();
    let cancelled = false;
    loadSavedTrips(local.map(savedBody))
      .then((state) => {
        if (cancelled) return;
        if (!state.signedIn) {
          setSignedIn(false);
          setItems(local);
          return;
        }
        setSignedIn(true);
        if (state.imported) writeLocalTrips([]);
        setItems(state.ok ? fromAccount(state.items) : local);
        if (!state.ok) setError(state.code ?? "error");
      })
      .catch(() => {
        if (cancelled) return;
        setSignedIn(false);
        setItems(local);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function local(next: SavedTripItem[]) {
    writeLocalTrips(next);
    setItems(next);
  }

  async function create(body: SavedTripBody): Promise<string | null> {
    setError(null);
    if (signedIn) {
      const state = await createSavedTrip(body);
      if (state.signedIn) {
        if (state.ok && state.item) {
          setItems((prev) => [...fromAccount([state.item!]), ...prev]);
          return state.item.id;
        }
        setError(state.code ?? "error");
        return null;
      }
      setSignedIn(false);
    }
    if (items.length >= MAX_SAVED_TRIPS) {
      setError("limit_reached");
      return null;
    }
    const now = new Date().toISOString();
    const id = `local-${crypto.randomUUID().replaceAll("-", "")}`;
    local([{ id, created_at: now, updated_at: now, ...body }, ...items]);
    return id;
  }

  async function update(id: string, body: SavedTripBody): Promise<boolean> {
    setError(null);
    if (signedIn) {
      const state = await updateSavedTrip(id, body);
      if (state.signedIn && state.ok && state.item) {
        const [item] = fromAccount([state.item]);
        setItems((prev) => [item, ...prev.filter((t) => t.id !== id)]);
        return true;
      }
      setError(state.signedIn ? (state.code ?? "error") : "error");
      return false;
    }
    const current = items.find((t) => t.id === id);
    if (!current) return false;
    // Статус не змінюємо (як і сервер): лише назва, конфігурація й знімок.
    const next = {
      ...current,
      ...body,
      status: current.status,
      updated_at: new Date().toISOString(),
    };
    local([next, ...items.filter((t) => t.id !== id)]);
    return true;
  }

  async function patch(id: string, change: SavedTripPatch) {
    if (signedIn) {
      const state = await patchSavedTrip(id, change);
      if (!(state.signedIn && state.ok)) {
        setError("error");
        return;
      }
    }
    const next = items.map((t) =>
      t.id === id
        ? {
            ...t,
            ...(change.title ? { title: change.title } : {}),
            ...(change.status ? { status: change.status } : {}),
          }
        : t,
    );
    if (signedIn) setItems(next);
    else local(next);
  }

  async function remove(id: string) {
    if (signedIn) {
      const state = await deleteSavedTrip(id);
      if (!state.ok) {
        setError("error");
        return;
      }
    }
    const next = items.filter((t) => t.id !== id);
    if (signedIn) setItems(next);
    else local(next);
  }

  return (
    <SavedTripsContext.Provider value={{ signedIn, items, error, create, update, patch, remove }}>
      {children}
    </SavedTripsContext.Provider>
  );
}

function useSavedTrips(): SavedTrips {
  const ctx = useContext(SavedTripsContext);
  if (!ctx) throw new Error("SavedTripsProvider is missing");
  return ctx;
}

/**
 * «Зберегти поїздку» / «Зберегти зміни» (редагування збереженої — `savedId` з URL).
 * Зберігаємо структуровані дані: запит з вибором і знімок цін.
 */
export function SaveTripButton({
  body,
  savedId,
}: {
  body: SavedTripBody;
  savedId?: string | null;
}) {
  const t = useTranslations("savedTrips");
  const { signedIn, items, create, update, error } = useSavedTrips();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const editing = hydrated && savedId != null && items.some((i) => i.id === savedId);

  async function save() {
    setBusy(true);
    try {
      const ok = editing ? await update(savedId!, body) : (await create(body)) !== null;
      setDone(ok);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={done ? "secondary" : "default"}
        disabled={!hydrated || signedIn === null || busy}
        onClick={save}
        data-testid="trip-save"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : done ? (
          <BookmarkCheck className="size-3.5" aria-hidden />
        ) : (
          <BookmarkPlus className="size-3.5" aria-hidden />
        )}
        {done ? t("saved") : editing ? t("saveChanges") : t("save")}
      </Button>
      {done && (
        <Link href="/trips" className="text-primary text-xs font-medium underline">
          {t("myTrips")}
        </Link>
      )}
      {error && (
        <span className="text-destructive text-xs" role="status">
          {t(error === "limit_reached" ? "limit" : "failed", { max: MAX_SAVED_TRIPS })}
        </span>
      )}
    </div>
  );
}

/** «Поділитися»: посилання на ту саму конфігурацію (стан поїздки — у URL, без особистих даних). */
export function ShareTripButton({ href }: { href: string }) {
  const t = useTranslations("savedTrips");
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = new URL(href, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Скасування діалогу «Поділитися» — не помилка.
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={share} data-testid="trip-share">
      <Share2 className="size-3.5" aria-hidden />
      {copied ? t("copied") : t("share")}
    </Button>
  );
}

/** Сторінка «Мої поїздки»: збережені конфігурації з історичними цінами й «Оновити ціни». */
export function SavedTripsList() {
  const t = useTranslations("savedTrips");
  const { signedIn, items, error } = useSavedTrips();
  const [filter, setFilter] = useState<"all" | TripStatus>("all");
  if (signedIn === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        {signedIn ? t("whereAccount") : t("whereBrowser")}
      </p>
      {error && (
        <p className="text-destructive text-sm" role="status">
          {t("failed")}
        </p>
      )}
      {items.length > 0 && (
        <div role="tablist" aria-label={t("statusFilter")} className="flex flex-wrap gap-1.5">
          {(["all", ...TRIP_STATUSES] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm transition-colors",
                filter === f
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:border-primary/50",
              )}
              data-testid={`trips-filter-${f}`}
            >
              {f === "all" ? t("all") : t(`statusPlural.${f}`)} (
              {f === "all" ? items.length : items.filter((i) => (i.status ?? "draft") === f).length}
              )
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <p className="bg-card rounded-xl border p-6 text-center text-sm" data-testid="trips-empty">
          {t("empty")}{" "}
          <Link href="/trip" className="text-primary font-medium underline">
            {t("plan")}
          </Link>
        </p>
      ) : (
        <ul className="grid gap-3" data-testid="saved-trips">
          {items
            .filter((item) => filter === "all" || (item.status ?? "draft") === filter)
            .map((item) => (
              <li key={item.id}>
                <SavedTripCard item={item} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

type Refresh =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; result: TripRefresh }
  | { state: "failed" };

function SavedTripCard({ item }: { item: SavedTripItem }) {
  const t = useTranslations("savedTrips");
  const tStay = useTranslations("stayCard");
  const format = useFormatter();
  const { create, patch, remove } = useSavedTrips();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [refresh, setRefresh] = useState<Refresh>({ state: "idle" });
  const s = item.snapshot;
  const href = `/trip?${toTripParams(item.query)}`;
  const money = (value: number | string) =>
    format.number(Number(value), {
      style: "currency",
      currency: s.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const at = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  async function update() {
    setRefresh({ state: "loading" });
    try {
      const response = await fetch("/api/trips/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: item.query, saved_total: s.money_total }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setRefresh({ state: "done", result: (await response.json()) as TripRefresh });
    } catch {
      setRefresh({ state: "failed" });
    }
  }

  return (
    <Card className="gap-3 p-4" data-testid="saved-trip">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
                if (title) await patch(item.id, { title: title.slice(0, 120) });
                setEditing(false);
              }}
            >
              <Input
                name="title"
                defaultValue={item.title}
                maxLength={120}
                aria-label={t("title")}
                className={cn(FIELD_CLASS, "h-8")}
                autoFocus
              />
              <Button type="submit" size="sm">
                {t("ok")}
              </Button>
            </form>
          ) : (
            <h2 className="flex items-center gap-2 text-lg leading-tight font-semibold">
              {item.title}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("rename")}
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            </h2>
          )}
          <p className="text-muted-foreground text-xs">
            {s.flight.origin} → {s.flight.destination} · {day(s.check_in)} – {day(s.check_out)} ·{" "}
            {t("nights", { count: s.nights })}
          </p>
          <p className="text-xs">
            {t("flightLine", {
              out: localTime(s.flight.departure_at),
              back: localTime(s.flight.return_departure_at),
              stops: s.flight.stops,
            })}{" "}
            · {s.stay.name}
            {s.stay.rating != null &&
              ` · ★ ${format.number(s.stay.rating, { maximumFractionDigits: 1 })}`}
            {s.stay.cancellation ? ` · ${tStay(`cancellation.${s.stay.cancellation}`)}` : ""}
          </p>
          <StatusControl item={item} />
        </div>
        <div className="text-right">
          <p className="text-xl font-bold tabular-nums" data-testid="saved-trip-total">
            {money(s.money_total)}
          </p>
          <p className="text-muted-foreground max-w-52 text-[11px] leading-snug">
            {t("pricedAt", { date: at(s.priced_at) })}
            {s.unknown > 0 ? ` · ${t("unknown", { count: s.unknown })}` : ""}
          </p>
        </div>
      </div>

      {refresh.state === "done" && <RefreshNote result={refresh.result} money={money} />}
      {refresh.state === "failed" && (
        <p className="text-destructive text-xs" role="status">
          {t("refreshFailed")}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={`${href}&saved=${encodeURIComponent(item.id)}`} data-testid="saved-trip-open">
            <Pencil className="size-3.5" aria-hidden />
            {t("edit")}
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={update}
          disabled={refresh.state === "loading"}
          data-testid="saved-trip-refresh"
        >
          {refresh.state === "loading" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {t("refresh")}
        </Button>
        {item.query.return_date && (
          // Підписка — на сторінці поїздки, тим самим компонентом, що й з результатів.
          <Button asChild size="sm" variant="outline">
            <Link href={`${href}#price-alert`} data-testid="saved-trip-watch">
              <Bell className="size-3.5" aria-hidden />
              {t("watch")}
            </Link>
          </Button>
        )}
        <ShareTripButton href={href} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            create({
              ...savedBody(item),
              title: t("copyTitle", { title: item.title }).slice(0, 120),
            })
          }
          data-testid="saved-trip-copy"
        >
          <Copy className="size-3.5" aria-hidden />
          {t("copy")}
        </Button>
        <TripCompareToggle item={{ key: item.id, title: item.title, snapshot: s }} />
        {confirm ? (
          <span className="flex items-center gap-1 text-xs">
            {t("confirmDelete")}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => remove(item.id)}
              data-testid="saved-trip-delete-yes"
            >
              {t("yes")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              {t("no")}
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setConfirm(true)}
            data-testid="saved-trip-delete"
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t("delete")}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * Статус поїздки (модуль 10a): чернетка / запланована / архівна. «Заброньованої» немає —
 * бронювання SkyPack не бачить. Минула поїздка — підказка перенести в архів.
 */
function StatusControl({ item }: { item: SavedTripItem }) {
  const t = useTranslations("savedTrips");
  const { patch } = useSavedTrips();
  const status = item.status ?? "draft";
  const past = item.snapshot.check_out < new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{t("statusLabel")}</span>
        <select
          value={status}
          onChange={(e) => patch(item.id, { status: e.target.value as TripStatus })}
          className={cn(SELECT_CLASS, "h-7 w-auto py-0 text-xs")}
          data-testid="saved-trip-status"
        >
          {TRIP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </label>
      {past && status !== "archived" && <span className="text-warning">{t("pastHint")}</span>}
    </div>
  );
}

function RefreshNote({ result, money }: { result: TripRefresh; money: (value: number) => string }) {
  const t = useTranslations("savedTrips");
  if (!result.current) {
    return (
      <p
        className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        role="status"
      >
        {t("refreshNone")}
      </p>
    );
  }
  const diff = result.difference ?? 0;
  const notes = [
    !result.flight_available ? t("flightGone") : null,
    !result.stay_available ? t("stayGone") : null,
  ].filter((x): x is string => x !== null);
  return (
    <div
      className={cn(
        "grid gap-1 rounded-lg border px-3 py-2 text-xs",
        notes.length ? "border-warning/40 bg-warning/10" : "border-success/40 bg-success/5",
      )}
      role="status"
      data-testid="saved-trip-refreshed"
    >
      <p className="text-sm">
        {t("nowTotal", { total: money(result.current.money_total) })}{" "}
        <span
          className={cn("font-medium", diff < 0 ? "text-success" : diff > 0 ? "text-warning" : "")}
        >
          {diff === 0
            ? t("same")
            : diff < 0
              ? t("cheaper", { amount: money(-diff) })
              : t("pricier", { amount: money(diff) })}
        </span>
      </p>
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}
