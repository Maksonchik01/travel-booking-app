"use client";

import type { ChatReply, ChatTurn, FlightQuery } from "@tickets/shared";
import { Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { toSearchParams } from "@/lib/search-params";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 500;
/** Стільки останніх реплік приймає API. */
const MAX_TURNS = 20;
/** Розмова живе лише до закриття вкладки (sessionStorage), на сервері її немає. */
const STORAGE_KEY = "tickets.chat.v1";

export type ChatBodyInput = {
  messages: ChatTurn[];
  current_search: FlightQuery | null;
  home_airport: string | null;
};

type Props = {
  /** Пошук з URL сторінки: «а прямі?» стосується саме його. */
  currentSearch?: FlightQuery;
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

function restore(): ChatTurn[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? (saved as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

function save(messages: ChatTurn[]) {
  try {
    if (messages.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим чи заборонене сховище — розмова просто не переживе оновлення.
  }
}

/**
 * Розмова з ШІ-агентом про перельоти. Агент шукає тими самими пошуком і скорингом, що й
 * форма; знайдене відкривається звичайною сторінкою результатів (URL), чат лишається.
 */
export function AIChat(props: Props) {
  const hydrated = useHydrated();
  // До гідратації sessionStorage недоступний — показуємо порожній чат, потім відновлюємо.
  return <ChatBox key={hydrated ? "restored" : "server"} restored={hydrated} {...props} />;
}

function ChatBox({
  currentSearch,
  homeAirport,
  send = sendViaApi,
  restored,
}: Props & { restored: boolean }) {
  const t = useTranslations("ai");
  const router = useRouter();
  const [messages, setMessages] = useState<ChatTurn[]>(() => (restored ? restore() : []));
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function update(next: ChatTurn[]) {
    setMessages(next);
    save(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    const asked = [...messages, { role: "user" as const, text }];
    update(asked);
    setDraft("");
    setFailed(false);
    startTransition(async () => {
      let reply: ChatReply | null;
      try {
        reply = await send({
          messages: asked.slice(-MAX_TURNS),
          current_search: currentSearch ?? null,
          home_airport: homeAirport ?? null,
        });
      } catch {
        reply = null;
      }
      if (!reply || reply.status === "unavailable") {
        // Повідомлення повертаємо в поле — можна надіслати ще раз.
        update(messages);
        setDraft(text);
        setFailed(true);
        return;
      }
      const answer =
        reply.status === "ok" && reply.reply
          ? reply.reply
          : t(reply.search ? "fallbackFound" : "fallback");
      update([...asked, { role: "assistant", text: answer }]);
      if (reply.search) {
        router.push(`/?${toSearchParams({ query: reply.search, sort: "price" })}`);
      }
    });
  }

  const started = messages.length > 0;
  return (
    <form onSubmit={submit} className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="ai-message" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="text-primary size-4" aria-hidden />
          {t("label")}
        </label>
        {started && (
          <button
            type="button"
            onClick={() => {
              update([]);
              setFailed(false);
            }}
            className="text-primary text-xs underline-offset-2 hover:underline"
          >
            {t("newChat")}
          </button>
        )}
      </div>
      {(started || pending) && (
        <ol
          aria-live="polite"
          aria-label={t("conversation")}
          className="bg-muted/40 grid max-h-80 gap-2 overflow-y-auto rounded-md border p-3 text-sm"
        >
          {messages.map((turn, i) => (
            <li
              key={i}
              data-role={turn.role}
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-line",
                turn.role === "user"
                  ? "bg-primary text-primary-foreground justify-self-end"
                  : "bg-background justify-self-start border",
              )}
            >
              <span className="sr-only">{t(turn.role === "user" ? "you" : "assistant")}: </span>
              {turn.text}
            </li>
          ))}
          {pending && (
            <li className="text-muted-foreground flex items-center gap-1.5 justify-self-start">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("thinking")}
            </li>
          )}
        </ol>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="ai-message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_LENGTH}
          placeholder={started ? t("followUpPlaceholder") : t("placeholder")}
          className="border-input bg-background h-10 min-w-0 flex-1 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          autoComplete="off"
        />
        <Button type="submit" variant="secondary" disabled={pending || !draft.trim()}>
          {t("submit")}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          {t("error")}
        </p>
      )}
      <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
    </form>
  );
}
