"use client";

import type {
  ChatMode,
  ChatReply,
  ChatTurn,
  FlightQuery,
  SavedTripBody,
  StayQuery,
  TripQuery,
  TripSnapshotInput,
} from "@tickets/shared";
import {
  ArrowLeft,
  BedDouble,
  History,
  Loader2,
  Luggage,
  Pencil,
  Plane,
  Plus,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { deleteChat, loadChatSync, saveChat, setChatSync } from "@/app/actions/chats";
import { ChatCards, cardLinks } from "@/components/chat-cards";
import { saveTripNow } from "@/components/saved-trips";
import { addToTripCompare } from "@/components/trip-compare";
import { previousTripParams, undoTripStep } from "@/components/trip-history";
import { Button } from "@/components/ui/button";
import {
  type ChatStore,
  type Conversation,
  EMPTY_STORE,
  historyList,
  newConversation,
  mergeStores,
  readStore,
  remove,
  rename,
  type StoredTurn,
  toBody,
  upsert,
  withTurns,
  writeStore,
} from "@/lib/chat-history";
import { toSearchParams } from "@/lib/search-params";
import { toStayParams } from "@/lib/stay-params";
import { OPEN_CHAT_EVENT, type OpenChatDetail } from "@/lib/ai-events";
import { parseTripParams, toTripParams } from "@/lib/trip-params";
import { FIELD_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { RetryNotice } from "@/components/retry";

const MAX_LENGTH = 500;
/** Стільки останніх реплік приймає API. */
const MAX_TURNS = 20;
export const CHAT_MODES: readonly ChatMode[] = ["flights", "stays", "trip"];

const MODE_ICON = { flights: Plane, stays: BedDouble, trip: Luggage } as const;

export type ChatBodyInput = {
  messages: ChatTurn[];
  mode: ChatMode;
  current_search: FlightQuery | null;
  current_stay_search: StayQuery | null;
  current_trip: TripQuery | null;
  previous_trip: TripQuery | null;
  home_airport: string | null;
  /** Мова інтерфейсу — нею відповідає помічник. */
  locale: string;
};

type Props = {
  /** Пошук перельотів з URL сторінки: «а прямі?» стосується саме його. */
  currentSearch?: FlightQuery;
  /** Пошук житла з URL сторінки. */
  currentStaySearch?: StayQuery;
  /** Поїздка з URL планувальника (з вибором рейсу й житла): «знайди дешевший готель». */
  currentTrip?: TripQuery;
  /** Код із поля «Звідки» — якщо в розмові місто вильоту не назване. */
  homeAirport?: string;
  /** Підміна мережі в тестах. */
  /** null — помилка; "rate_limited" — вичерпано ліміт запитів за годину. */
  send?: (body: ChatBodyInput) => Promise<ChatReply | "rate_limited" | null>;
};

/** Попередній крок поїздки з історії вкладки — як запит (повторювані ключі — масивом). */
function previousTrip(): TripQuery | null {
  const params = previousTripParams();
  if (!params) return null;
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(params)) {
    const prev = raw[key];
    raw[key] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
  }
  return parseTripParams(raw);
}

const CHAT_TIMEOUT_MS = 90_000;

async function sendViaApi(body: ChatBodyInput): Promise<ChatReply | "rate_limited" | null> {
  // Помічник може кілька разів звертатися до пошуку — запас більший, ніж для інших запитів.
  const response = await fetchWithTimeout(
    "/api/ai/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    CHAT_TIMEOUT_MS,
  );
  if (response.status === 429) return "rate_limited";
  return response.ok ? ((await response.json()) as ChatReply) : null;
}

/**
 * Розмова з ШІ-агентом. Агент шукає тими самими пошуком і скорингом, що й форми;
 * знайдене відкривається звичайними сторінками результатів. Розмови зберігаються в
 * цьому браузері: до будь-якої можна повернутися з «Історії» або почати нову.
 */
export function AIChat(props: Props) {
  const hydrated = useHydrated();
  // До гідратації localStorage недоступний — показуємо порожній чат, потім відновлюємо.
  return <ChatBox key={hydrated ? "restored" : "server"} restored={hydrated} {...props} />;
}

function ChatBox({
  currentSearch,
  currentStaySearch,
  currentTrip,
  homeAirport,
  send = sendViaApi,
  restored,
}: Props & { restored: boolean }) {
  const t = useTranslations("ai");
  const locale = useLocale();
  const router = useRouter();
  const [store, setStore] = useState<ChatStore>(() => (restored ? readStore() : EMPTY_STORE));
  // Відповідь моделі приходить пізніше — оновлюємо найсвіжіший стан, а не знімок з кліку.
  const latest = useRef(store);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [failed, setFailed] = useState<"error" | "rateLimited" | "saveFailed" | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const active = store.conversations.find((c) => c.id === store.activeId) ?? null;
  const history = historyList(store);

  function commit(next: ChatStore) {
    latest.current = next;
    setStore(next);
    writeStore(next);
  }

  // Синхронізація між пристроями (модуль 9c) — лише за згодою; null — ще не відомо.
  const [sync, setSync] = useState<{ signedIn: boolean; enabled: boolean } | null>(null);
  const syncing = useRef(false);

  useEffect(() => {
    if (!restored) return;
    let cancelled = false;
    loadChatSync()
      .then((state) => {
        if (cancelled) return;
        const enabled = state.signedIn && state.enabled;
        syncing.current = enabled;
        setSync({ signedIn: state.signedIn, enabled });
        if (state.signedIn && state.enabled) {
          const { store: merged, upload } = mergeStores(latest.current, state.conversations ?? []);
          commit(merged);
          for (const c of upload) void saveChat(c.id, toBody(c)).catch(() => undefined);
        }
      })
      .catch(() => setSync({ signedIn: false, enabled: false }));
    return () => {
      cancelled = true;
    };
    // Разово після відновлення з браузера.
  }, [restored]);

  /** Зміну розмови — в акаунт, якщо синхронізацію увімкнено (помилка не ламає чат). */
  function push(id: string) {
    if (!syncing.current) return;
    const conversation = latest.current.conversations.find((c) => c.id === id);
    if (conversation?.turns.length) {
      void saveChat(conversation.id, toBody(conversation)).catch(() => undefined);
    }
  }

  async function toggleSync(enabled: boolean) {
    const state = await setChatSync(enabled);
    const on = state.signedIn && state.enabled;
    syncing.current = on;
    setSync({ signedIn: state.signedIn, enabled: on });
    // Згода щойно дана — вивантажуємо розмови цього браузера.
    if (on) for (const c of historyList(latest.current)) push(c.id);
  }

  function setTurns(id: string, turns: StoredTurn[]) {
    const conversation = latest.current.conversations.find((c) => c.id === id);
    if (!conversation) return; // розмову встигли видалити
    commit(upsert(latest.current, withTurns(conversation, turns, Date.now())));
    push(id);
  }

  function start(mode: ChatMode) {
    const conversation = newConversation(mode, Date.now(), crypto.randomUUID());
    commit({ ...upsert(latest.current, conversation), activeId: conversation.id });
    setShowHistory(false);
    setFailed(null);
  }

  // «Оптимізувати з ШІ» з планувальника: нова розмова режиму й чернетка запиту. Попередні
  // сторінки Next тримає змонтованими (прихованими) — реагує лише чат поточної сторінки.
  const pathname = usePathname();
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (pathname !== window.location.pathname) return;
      const { mode, draft: text } = (event as CustomEvent<OpenChatDetail>).detail;
      start(mode);
      setDraft(text);
    };
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
  });

  function open(id: string) {
    commit({ ...latest.current, activeId: id });
    setShowHistory(false);
    setFailed(null);
  }

  function newChat() {
    commit({ ...latest.current, activeId: null });
    setShowHistory(false);
    setFailed(null);
    setDraft("");
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pendingId || !active) return;
    const { id, mode } = active;
    const before = active.turns;
    const asked: StoredTurn[] = [...before, { role: "user", text }];
    setTurns(id, asked);
    setDraft("");
    setFailed(null);
    setPendingId(id);
    startTransition(async () => {
      let reply: ChatReply | "rate_limited" | null;
      try {
        reply = await send({
          // На сервер — лише текст реплік, без локальних посилань.
          messages: asked.slice(-MAX_TURNS).map(({ role, text }) => ({ role, text })),
          mode,
          current_search: currentSearch ?? null,
          current_stay_search: currentStaySearch ?? null,
          current_trip: currentTrip ?? null,
          previous_trip: currentTrip ? previousTrip() : null,
          home_airport: homeAirport ?? null,
          locale,
        });
      } catch {
        reply = null;
      }
      setPendingId(null);
      if (!reply || reply === "rate_limited" || reply.status === "unavailable") {
        // Повідомлення повертаємо в поле — можна надіслати ще раз.
        setTurns(id, before);
        setDraft(text);
        setFailed(reply === "rate_limited" ? "rateLimited" : "error");
        return;
      }
      const found = Boolean(reply.search || reply.stay_search || reply.trip_search);
      const answer =
        reply.status === "ok" && reply.reply
          ? reply.reply
          : t(found ? "fallbackFound" : "fallback");
      const flightsHref = reply.search
        ? `/?${toSearchParams({ query: reply.search, sort: "price" })}`
        : undefined;
      const staysHref = reply.stay_search
        ? `/stays?${toStayParams({ query: reply.stay_search, sort: "price" })}`
        : undefined;
      const tripHref = reply.trip_search ? `/trip?${toTripParams(reply.trip_search)}` : undefined;
      // Посилання на знайдене зберігаємо в репліці: з історії можна повернутися до результатів.
      const links = found ? { flights: flightsHref, stays: staysHref, trip: tripHref } : undefined;
      // Картки (модуль 9b) — з готовими посиланнями: переглянути й перенести в планувальник.
      const cards = cardLinks(
        reply.cards,
        { flights: flightsHref, stays: staysHref },
        { flight: reply.search, stay: reply.stay_search },
      );
      setTurns(id, [
        ...asked,
        { role: "assistant", text: answer, links, ...(cards.length ? { cards } : {}) },
      ]);
      // Квитки й житло відкриваються одразу; «уся поїздка» — посиланням на сторінку поїздки.
      if (mode === "flights" && flightsHref) router.push(flightsHref);
      if (mode === "stays" && staysHref) router.push(staysHref);
      // Команди готової поїздки (модуль 9a) змінюють реальний стан сторінки планувальника.
      if (mode === "trip") {
        if (reply.trip_action === "undo") undoTripStep(router);
        else if (tripHref && currentTrip) router.push(tripHref, { scroll: false });
        if (reply.compare?.length) {
          addToTripCompare(
            reply.compare.map((c) => ({
              key: c.key,
              title: c.title,
              snapshot: c.snapshot as TripSnapshotInput,
            })),
          );
        }
        if (reply.save_trip) {
          const saved = await saveTripNow(reply.save_trip as SavedTripBody);
          if (!saved) setFailed("saveFailed");
        }
      }
    });
  }

  const pending = pendingId !== null && pendingId === active?.id;
  return (
    <form ref={formRef} onSubmit={submit} className="grid gap-3">
      {/* Заголовок «ШІ-помічник» — у шапці панелі (search-tabs.tsx); тут лише підпис поля. */}
      <div className="flex flex-wrap items-center justify-end gap-2 empty:hidden">
        <label htmlFor="ai-message" className="sr-only">
          {t("label")}
        </label>
        <div className="flex items-center gap-1">
          {history.length > 0 && (
            <HeaderButton
              onClick={() => setShowHistory((v) => !v)}
              pressed={showHistory}
              icon={showHistory ? ArrowLeft : History}
            >
              {showHistory ? t("backToChat") : t("history", { count: history.length })}
            </HeaderButton>
          )}
          {(active || showHistory) && (
            <HeaderButton onClick={newChat} icon={Plus}>
              {t("newChat")}
            </HeaderButton>
          )}
        </div>
      </div>

      {showHistory ? (
        <HistoryList
          items={history}
          activeId={store.activeId}
          onOpen={open}
          onDelete={(id) => {
            commit(remove(latest.current, id));
            if (syncing.current) void deleteChat(id).catch(() => undefined);
          }}
          onRename={(id, title) => {
            const renamed = rename(latest.current, id, title);
            commit({
              ...renamed,
              conversations: renamed.conversations.map((c) =>
                c.id === id ? { ...c, updatedAt: Date.now() } : c,
              ),
            });
            push(id);
          }}
          sync={sync}
          onToggleSync={toggleSync}
        />
      ) : active ? (
        <ConversationView conversation={active} pending={pending} />
      ) : (
        <ModeChooser onChoose={start} />
      )}

      {active && !showHistory && (
        <div className="flex flex-col gap-2 @sm:flex-row">
          <input
            id="ai-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_LENGTH}
            placeholder={t(`placeholder.${active.mode}`)}
            className={cn(
              FIELD_CLASS,
              // flex-1 лише в рядку: у стовпчику він стискав поле до нуля по висоті.
              "border-input min-w-0 border px-3.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 @sm:flex-1",
            )}
            autoComplete="off"
          />
          <Button
            type="submit"
            className="shadow-primary/25 h-11 rounded-lg px-5 shadow-md transition-all hover:-translate-y-px hover:shadow-lg active:translate-y-0"
            disabled={pending || !draft.trim()}
          >
            <SendHorizontal className="size-4" aria-hidden />
            {t("submit")}
          </Button>
        </div>
      )}
      {failed === "error" ? (
        // Повідомлення вже повернуто в поле — «Спробувати ще раз» надсилає його знову.
        <RetryNotice
          message={t(failed)}
          onRetry={() => formRef.current?.requestSubmit()}
          className="text-sm"
        />
      ) : (
        failed && (
          <p role="alert" className="text-sm text-warning">
            {t(failed)}
          </p>
        )
      )}
      <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
    </form>
  );
}

function HeaderButton({
  onClick,
  icon: Icon,
  pressed,
  children,
}: {
  onClick: () => void;
  icon: typeof Plus;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className="text-muted-foreground hover:text-primary hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors"
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

/** Перше питання помічника: що саме шукаємо. Готовий текст, без виклику моделі. */
function ModeChooser({ onChoose }: { onChoose: (mode: ChatMode) => void }) {
  const t = useTranslations("ai");
  return (
    <div className="bg-muted/40 grid gap-3 rounded-xl border p-3">
      <p className="bg-card justify-self-start rounded-2xl rounded-bl-md border px-3.5 py-2 text-sm shadow-xs">
        {t("greeting")}
      </p>
      <div className="grid gap-2 @2xl:grid-cols-3">
        {CHAT_MODES.map((mode) => {
          const Icon = MODE_ICON[mode];
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onChoose(mode)}
              className="bg-card hover:border-primary/50 lift grid gap-1 rounded-xl border p-3 text-left"
            >
              <span className="flex items-center gap-2 font-medium">
                <span className="bg-accent text-primary grid size-7 place-items-center rounded-lg">
                  <Icon className="size-4" aria-hidden />
                </span>
                {t(`mode.${mode}`)}
              </span>
              <span className="text-muted-foreground text-xs">{t(`modeHint.${mode}`)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConversationView({
  conversation,
  pending,
}: {
  conversation: Conversation;
  pending: boolean;
}) {
  const t = useTranslations("ai");
  const Icon = MODE_ICON[conversation.mode];
  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="text-primary size-3.5" aria-hidden />
        {t("modeChat", { mode: t(`mode.${conversation.mode}`) })}
      </p>
      <ol
        aria-live="polite"
        aria-label={t("conversation")}
        className="bg-muted/40 grid max-h-[32rem] gap-2.5 overflow-y-auto rounded-xl border p-3 text-sm"
      >
        {/* Підказка режиму — локальна, моделі не надсилається. */}
        <Bubble role="assistant">{t(`intro.${conversation.mode}`)}</Bubble>
        {conversation.turns.map((turn, i) => (
          <Bubble
            key={i}
            role={turn.role}
            label={t(turn.role === "user" ? "you" : "assistant")}
            wide={Boolean(turn.cards?.length)}
          >
            {turn.text}
            {turn.cards?.length ? <ChatCards cards={turn.cards} now={new Date()} /> : null}
            {turn.links && <ResultLinks links={turn.links} />}
          </Bubble>
        ))}
        {pending && (
          <li className="bg-card text-muted-foreground animate-in fade-in-0 flex items-center gap-1.5 justify-self-start rounded-2xl rounded-bl-md border px-3.5 py-2 shadow-xs">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("thinking")}
          </li>
        )}
      </ol>
    </div>
  );
}

function HistoryList({
  items,
  activeId,
  onOpen,
  onDelete,
  onRename,
  sync,
  onToggleSync,
}: {
  items: Conversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  sync: { signedIn: boolean; enabled: boolean } | null;
  onToggleSync: (enabled: boolean) => Promise<void>;
}) {
  const t = useTranslations("ai");
  const format = useFormatter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  function saveTitle(id: string) {
    const title = draftTitle.trim();
    if (title) onRename(id, title);
    setEditing(null);
  }

  return (
    <div className="grid gap-2">
      <ul
        aria-label={t("historyTitle")}
        className="bg-muted/40 grid max-h-96 gap-1.5 overflow-y-auto rounded-xl border p-2"
      >
        {items.map((c) => {
          const Icon = MODE_ICON[c.mode];
          return (
            <li
              key={c.id}
              className={cn(
                "group bg-card flex items-center gap-2 rounded-lg border p-1 pr-1.5 transition-colors",
                c.id === activeId ? "border-primary/50" : "hover:border-primary/40",
              )}
            >
              {editing === c.id ? (
                // Без <form>: список уже всередині форми чату, а вкладені форми ламаються.
                <div className="flex min-w-0 flex-1 items-center gap-2 p-1">
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveTitle(c.id);
                      }
                      if (e.key === "Escape") setEditing(null);
                    }}
                    maxLength={60}
                    aria-label={t("renameLabel")}
                    autoFocus
                    className={cn(FIELD_CLASS, "h-8 min-w-0 flex-1")}
                  />
                  <Button type="button" size="sm" onClick={() => saveTitle(c.id)}>
                    {t("renameSave")}
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-left"
                >
                  <span className="bg-accent text-primary grid size-8 shrink-0 place-items-center rounded-lg">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="grid min-w-0">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {t(`mode.${c.mode}`)} ·{" "}
                      {format.dateTime(new Date(c.updatedAt), {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraftTitle(c.title);
                  setEditing(editing === c.id ? null : c.id);
                }}
                aria-label={t("renameChat", { title: c.title })}
                className="text-muted-foreground hover:text-foreground hover:bg-muted grid size-8 shrink-0 place-items-center rounded-md transition-colors"
                data-testid="chat-rename"
              >
                <Pencil className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                aria-label={t("deleteChat", { title: c.title })}
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 grid size-8 shrink-0 place-items-center rounded-md transition-colors"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <SyncPanel sync={sync} onToggle={onToggleSync} />
    </div>
  );
}

/** Згода на синхронізацію розмов (модуль 9c): вимкнено за замовчуванням, гостю — підказка. */
function SyncPanel({
  sync,
  onToggle,
}: {
  sync: { signedIn: boolean; enabled: boolean } | null;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  const t = useTranslations("ai");
  const [busy, setBusy] = useState(false);
  if (sync === null) return null;
  if (!sync.signedIn) {
    return <p className="text-muted-foreground text-xs">{t("syncGuest")}</p>;
  }
  return (
    <label className="flex items-start gap-2 text-xs" data-testid="chat-sync">
      <input
        type="checkbox"
        checked={sync.enabled}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await onToggle(e.target.checked);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-0.5 size-4"
      />
      <span className="grid gap-0.5">
        <span className="font-medium">{t("syncLabel")}</span>
        <span className="text-muted-foreground">
          {sync.enabled ? t("syncOnHint") : t("syncOffHint")}
        </span>
      </span>
    </label>
  );
}

function Bubble({
  role,
  label,
  children,
  wide = false,
}: {
  role: ChatTurn["role"];
  label?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <li
      data-role={role}
      className={cn(
        "animate-in fade-in-0 slide-in-from-bottom-1 rounded-2xl px-3.5 py-2 leading-relaxed whitespace-pre-line duration-200",
        // З картками — на всю ширину, щоб на телефоні картки не стискались.
        wide ? "w-full max-w-full @2xl:max-w-[85%]" : "max-w-[85%]",
        role === "user"
          ? "bg-primary text-primary-foreground justify-self-end rounded-br-md"
          : "bg-card justify-self-start rounded-bl-md border shadow-xs",
      )}
    >
      {label && <span className="sr-only">{label}: </span>}
      {children}
    </li>
  );
}

function ResultLinks({ links }: { links: NonNullable<StoredTurn["links"]> }) {
  const t = useTranslations("ai");
  const items = [
    { href: links.flights, icon: Plane, label: t("openFlights") },
    { href: links.stays, icon: BedDouble, label: t("openStays") },
    { href: links.trip, icon: Luggage, label: t("openTrip") },
  ].filter((item): item is { href: string; icon: typeof Plane; label: string } => !!item.href);
  return (
    <span className="mt-2 flex flex-wrap gap-2">
      {items.map(({ href, icon: Icon, label }) => (
        <Link
          key={href}
          href={href}
          className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </Link>
      ))}
    </span>
  );
}
