"use client";

import type { ChatMode, ChatReply, ChatTurn, FlightQuery, StayQuery } from "@tickets/shared";
import {
  BedDouble,
  Loader2,
  Luggage,
  Plane,
  RotateCcw,
  SendHorizontal,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { toSearchParams } from "@/lib/search-params";
import { toStayParams } from "@/lib/stay-params";
import { FIELD_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 500;
/** Стільки останніх реплік приймає API. */
const MAX_TURNS = 20;
export const CHAT_MODES: readonly ChatMode[] = ["flights", "stays", "trip"];
/**
 * Розмови живуть лише до закриття вкладки (sessionStorage), на сервері їх немає.
 * Кожен режим — окрема розмова, щоб квитки й житло не змішувались.
 */
export const CHAT_MODE_KEY = "tickets.chat.mode";
const historyKey = (mode: ChatMode) => `tickets.chat.${mode}.v1`;

const MODE_ICON = { flights: Plane, stays: BedDouble, trip: Luggage } as const;

/** Репліка в браузері: для «усієї поїздки» — ще й посилання на знайдене. */
type StoredTurn = ChatTurn & { links?: { flights?: string; stays?: string } };

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

function read<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value == null || (Array.isArray(value) && value.length === 0)) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Приватний режим чи заборонене сховище — розмова просто не переживе оновлення.
  }
}

function restoreMode(): ChatMode | null {
  const saved = read<unknown>(CHAT_MODE_KEY, null);
  return CHAT_MODES.find((m) => m === saved) ?? null;
}

function restoreHistories(): Record<ChatMode, StoredTurn[]> {
  return {
    flights: read<StoredTurn[]>(historyKey("flights"), []),
    stays: read<StoredTurn[]>(historyKey("stays"), []),
    trip: read<StoredTurn[]>(historyKey("trip"), []),
  };
}

/**
 * Розмова з ШІ-агентом. Агент шукає тими самими пошуком і скорингом, що й форми;
 * знайдене відкривається звичайними сторінками результатів, чат лишається.
 */
export function AIChat(props: Props) {
  const hydrated = useHydrated();
  // До гідратації sessionStorage недоступний — показуємо порожній чат, потім відновлюємо.
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
  const [mode, setMode] = useState<ChatMode | null>(() => (restored ? restoreMode() : null));
  const [histories, setHistories] = useState<Record<ChatMode, StoredTurn[]>>(() =>
    restored ? restoreHistories() : { flights: [], stays: [], trip: [] },
  );
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const messages = mode ? histories[mode] : [];

  function chooseMode(next: ChatMode) {
    setMode(next);
    setFailed(false);
    write(CHAT_MODE_KEY, next);
  }

  function update(target: ChatMode, next: StoredTurn[]) {
    setHistories((all) => ({ ...all, [target]: next }));
    write(historyKey(target), next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending || !mode) return;
    const target = mode;
    const before = histories[target];
    const asked: StoredTurn[] = [...before, { role: "user", text }];
    update(target, asked);
    setDraft("");
    setFailed(false);
    startTransition(async () => {
      let reply: ChatReply | null;
      try {
        reply = await send({
          // На сервер — лише текст реплік, без локальних посилань.
          messages: asked.slice(-MAX_TURNS).map(({ role, text }) => ({ role, text })),
          mode: target,
          current_search: currentSearch ?? null,
          current_stay_search: currentStaySearch ?? null,
          home_airport: homeAirport ?? null,
        });
      } catch {
        reply = null;
      }
      if (!reply || reply.status === "unavailable") {
        // Повідомлення повертаємо в поле — можна надіслати ще раз.
        update(target, before);
        setDraft(text);
        setFailed(true);
        return;
      }
      const found = Boolean(reply.search || reply.stay_search);
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
      // «Уся поїздка» знаходить і квитки, і житло — даємо обидва посилання, без переходу.
      const links =
        target === "trip" && found ? { flights: flightsHref, stays: staysHref } : undefined;
      update(target, [...asked, { role: "assistant", text: answer, links }]);
      if (target === "flights" && flightsHref) router.push(flightsHref);
      if (target === "stays" && staysHref) router.push(staysHref);
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="ai-message" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="text-primary size-4" aria-hidden />
          {t("label")}
        </label>
        {mode && messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              update(mode, []);
              setFailed(false);
            }}
            className="text-muted-foreground hover:text-primary flex items-center gap-1 rounded text-xs transition-colors"
          >
            <RotateCcw className="size-3" aria-hidden />
            {t("newChat")}
          </button>
        )}
      </div>

      {mode ? (
        <ModeSwitcher mode={mode} histories={histories} onChange={chooseMode} />
      ) : (
        <ModeChooser onChoose={chooseMode} />
      )}

      {mode && (
        <ol
          aria-live="polite"
          aria-label={t("conversation")}
          className="bg-muted/40 grid max-h-96 gap-2.5 overflow-y-auto rounded-xl border p-3 text-sm"
        >
          {/* Підказка режиму — локальна, моделі не надсилається. */}
          <Bubble role="assistant">{t(`intro.${mode}`)}</Bubble>
          {messages.map((turn, i) => (
            <Bubble key={i} role={turn.role} label={t(turn.role === "user" ? "you" : "assistant")}>
              {turn.text}
              {turn.links && <TripLinks links={turn.links} />}
            </Bubble>
          ))}
          {pending && (
            <li className="bg-card text-muted-foreground animate-in fade-in-0 flex items-center gap-1.5 justify-self-start rounded-2xl rounded-bl-md border px-3.5 py-2 shadow-xs">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("thinking")}
            </li>
          )}
        </ol>
      )}

      {mode && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="ai-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_LENGTH}
            placeholder={t(`placeholder.${mode}`)}
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

/** Перемикач між окремими розмовами; крапка — у цьому режимі вже є розмова. */
function ModeSwitcher({
  mode,
  histories,
  onChange,
}: {
  mode: ChatMode;
  histories: Record<ChatMode, StoredTurn[]>;
  onChange: (mode: ChatMode) => void;
}) {
  const t = useTranslations("ai");
  return (
    <div role="group" aria-label={t("modes")} className="flex flex-wrap gap-1.5">
      {CHAT_MODES.map((m) => {
        const Icon = MODE_ICON[m];
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(m)}
            className={cn(
              "relative flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
              active
                ? "border-primary bg-primary text-primary-foreground shadow-sm"
                : "bg-card text-muted-foreground hover:border-primary/50 hover:text-primary",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {t(`mode.${m}`)}
            {!active && histories[m].length > 0 && (
              <span className="bg-primary absolute -top-0.5 -right-0.5 size-2 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
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

function TripLinks({ links }: { links: NonNullable<StoredTurn["links"]> }) {
  const t = useTranslations("ai");
  return (
    <span className="mt-2 flex flex-wrap gap-2">
      {links.flights && (
        <Link
          href={links.flights}
          className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
        >
          <Plane className="size-3.5" aria-hidden />
          {t("openFlights")}
        </Link>
      )}
      {links.stays && (
        <Link
          href={links.stays}
          className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
        >
          <BedDouble className="size-3.5" aria-hidden />
          {t("openStays")}
        </Link>
      )}
    </span>
  );
}
