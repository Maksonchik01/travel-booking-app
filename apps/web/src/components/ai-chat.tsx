"use client";

import type { ChatMode, ChatReply, ChatTurn, FlightQuery, StayQuery } from "@tickets/shared";
import {
  ArrowLeft,
  BedDouble,
  History,
  Loader2,
  Luggage,
  Plane,
  Plus,
  SendHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  type ChatStore,
  type Conversation,
  EMPTY_STORE,
  historyList,
  newConversation,
  readStore,
  remove,
  type StoredTurn,
  upsert,
  withTurns,
  writeStore,
} from "@/lib/chat-history";
import { toSearchParams } from "@/lib/search-params";
import { toStayParams } from "@/lib/stay-params";
import { toTripParams } from "@/lib/trip-params";
import { FIELD_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

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
  home_airport: string | null;
};

type Props = {
  /** Пошук перельотів з URL сторінки: «а прямі?» стосується саме його. */
  currentSearch?: FlightQuery;
  /** Пошук житла з URL сторінки. */
  currentStaySearch?: StayQuery;
  /** Код із поля «Звідки» — якщо в розмові місто вильоту не назване. */
  homeAirport?: string;
  /** Підміна мережі в тестах. */
  send?: (body: ChatBodyInput) => Promise<ChatReply | null>;
};

async function sendViaApi(body: ChatBodyInput): Promise<ChatReply | null> {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  homeAirport,
  send = sendViaApi,
  restored,
}: Props & { restored: boolean }) {
  const t = useTranslations("ai");
  const router = useRouter();
  const [store, setStore] = useState<ChatStore>(() => (restored ? readStore() : EMPTY_STORE));
  // Відповідь моделі приходить пізніше — оновлюємо найсвіжіший стан, а не знімок з кліку.
  const latest = useRef(store);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const active = store.conversations.find((c) => c.id === store.activeId) ?? null;
  const history = historyList(store);

  function commit(next: ChatStore) {
    latest.current = next;
    setStore(next);
    writeStore(next);
  }

  function setTurns(id: string, turns: StoredTurn[]) {
    const conversation = latest.current.conversations.find((c) => c.id === id);
    if (!conversation) return; // розмову встигли видалити
    commit(upsert(latest.current, withTurns(conversation, turns, Date.now())));
  }

  function start(mode: ChatMode) {
    const conversation = newConversation(mode, Date.now(), crypto.randomUUID());
    commit({ ...upsert(latest.current, conversation), activeId: conversation.id });
    setShowHistory(false);
    setFailed(false);
  }

  function open(id: string) {
    commit({ ...latest.current, activeId: id });
    setShowHistory(false);
    setFailed(false);
  }

  function newChat() {
    commit({ ...latest.current, activeId: null });
    setShowHistory(false);
    setFailed(false);
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
    setFailed(false);
    setPendingId(id);
    startTransition(async () => {
      let reply: ChatReply | null;
      try {
        reply = await send({
          // На сервер — лише текст реплік, без локальних посилань.
          messages: asked.slice(-MAX_TURNS).map(({ role, text }) => ({ role, text })),
          mode,
          current_search: currentSearch ?? null,
          current_stay_search: currentStaySearch ?? null,
          home_airport: homeAirport ?? null,
        });
      } catch {
        reply = null;
      }
      setPendingId(null);
      if (!reply || reply.status === "unavailable") {
        // Повідомлення повертаємо в поле — можна надіслати ще раз.
        setTurns(id, before);
        setDraft(text);
        setFailed(true);
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
      setTurns(id, [...asked, { role: "assistant", text: answer, links }]);
      // Квитки й житло відкриваються одразу; «уся поїздка» — посиланням на сторінку поїздки.
      if (mode === "flights" && flightsHref) router.push(flightsHref);
      if (mode === "stays" && staysHref) router.push(staysHref);
    });
  }

  const pending = pendingId !== null && pendingId === active?.id;
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="ai-message" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="text-primary size-4" aria-hidden />
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
          onDelete={(id) => commit(remove(latest.current, id))}
        />
      ) : active ? (
        <ConversationView conversation={active} pending={pending} />
      ) : (
        <ModeChooser onChoose={start} />
      )}

      {active && !showHistory && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="ai-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_LENGTH}
            placeholder={t(`placeholder.${active.mode}`)}
            className={cn(
              FIELD_CLASS,
              "border-input min-w-0 flex-1 border px-3.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
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
      {failed && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          {t("error")}
        </p>
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
      <div className="grid gap-2 sm:grid-cols-3">
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
        className="bg-muted/40 grid max-h-96 gap-2.5 overflow-y-auto rounded-xl border p-3 text-sm"
      >
        {/* Підказка режиму — локальна, моделі не надсилається. */}
        <Bubble role="assistant">{t(`intro.${conversation.mode}`)}</Bubble>
        {conversation.turns.map((turn, i) => (
          <Bubble key={i} role={turn.role} label={t(turn.role === "user" ? "you" : "assistant")}>
            {turn.text}
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
}: {
  items: Conversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("ai");
  const format = useFormatter();
  return (
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
  );
}

function Bubble({
  role,
  label,
  children,
}: {
  role: ChatTurn["role"];
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <li
      data-role={role}
      className={cn(
        "animate-in fade-in-0 slide-in-from-bottom-1 max-w-[85%] rounded-2xl px-3.5 py-2 leading-relaxed whitespace-pre-line duration-200",
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
