import type {
  ChatCard,
  ChatConversationBody,
  ChatConversationOut,
  ChatMode,
  ChatTurn,
} from "@tickets/shared";

/**
 * Історія розмов з помічником — у цьому браузері (localStorage); з акаунтом і ЛИШЕ за згодою
 * («Синхронізувати між пристроями», модуль 9c) — ще й в акаунті. Користувач може
 * перейменувати чи видалити будь-яку розмову. Кожна розмова має свій режим (квитки / житло /
 * уся поїздка), тож теми не змішуються.
 */
export const CHAT_STORAGE_KEY = "tickets.chats.v2";
export const MAX_CONVERSATIONS = 30;
/** Скільки реплік зберігаємо в одній розмові (моделі надсилаємо лише останні 20). */
export const MAX_STORED_TURNS = 80;
const TITLE_LENGTH = 60;

/**
 * Картка результату в репліці (модуль 9b) з готовими посиланнями: «Переглянути» — сторінка
 * результатів з якорем, `trip` — перенести в планувальник.
 */
export type StoredCard = { card: ChatCard; href?: string; trip?: string };

/** Репліка в браузері: для «усієї поїздки» — ще й посилання на знайдене й картки. */
export type StoredTurn = ChatTurn & {
  links?: { flights?: string; stays?: string; trip?: string };
  cards?: StoredCard[];
};

export type Conversation = {
  id: string;
  mode: ChatMode;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
};

export type ChatStore = {
  conversations: Conversation[];
  activeId: string | null;
};

export const EMPTY_STORE: ChatStore = { conversations: [], activeId: null };

const MODES: readonly ChatMode[] = ["flights", "stays", "trip"];

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    MODES.includes(c.mode as ChatMode) &&
    typeof c.title === "string" &&
    typeof c.updatedAt === "number" &&
    Array.isArray(c.turns)
  );
}

/** Биті чи чужі дані в сховищі — просто порожня історія, а не помилка. */
export function readStore(storage: Storage | undefined = globalThis.localStorage): ChatStore {
  try {
    const raw = JSON.parse(storage?.getItem(CHAT_STORAGE_KEY) ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null) return EMPTY_STORE;
    const { conversations, activeId } = raw as Record<string, unknown>;
    const valid = Array.isArray(conversations) ? conversations.filter(isConversation) : [];
    return {
      conversations: valid,
      activeId:
        typeof activeId === "string" && valid.some((c) => c.id === activeId) ? activeId : null,
    };
  } catch {
    return EMPTY_STORE;
  }
}

export function writeStore(
  store: ChatStore,
  storage: Storage | undefined = globalThis.localStorage,
) {
  try {
    // Порожні розмови (режим обрали, але нічого не написали) в історії не тримаємо.
    const conversations = store.conversations.filter(
      (c) => c.turns.length > 0 || c.id === store.activeId,
    );
    storage?.setItem(CHAT_STORAGE_KEY, JSON.stringify({ ...store, conversations }));
  } catch {
    // Приватний режим чи заборонене сховище — історія просто не збережеться.
  }
}

export function newConversation(mode: ChatMode, now: number, id: string): Conversation {
  return { id, mode, title: "", createdAt: now, updatedAt: now, turns: [] };
}

/** Нова чи оновлена розмова — нагору списку; найстаріші понад ліміт відкидаємо. */
export function upsert(store: ChatStore, conversation: Conversation): ChatStore {
  const others = store.conversations.filter((c) => c.id !== conversation.id);
  return {
    ...store,
    conversations: [conversation, ...others].slice(0, MAX_CONVERSATIONS),
  };
}

export function withTurns(conversation: Conversation, turns: StoredTurn[], now: number) {
  const firstQuestion = turns.find((t) => t.role === "user")?.text ?? "";
  return {
    ...conversation,
    turns: turns.slice(-MAX_STORED_TURNS),
    title: conversation.title || truncate(firstQuestion),
    updatedAt: now,
  };
}

export function remove(store: ChatStore, id: string): ChatStore {
  return {
    conversations: store.conversations.filter((c) => c.id !== id),
    activeId: store.activeId === id ? null : store.activeId,
  };
}

/** Розмови для списку «Історія»: лише з повідомленнями, найновіші вгорі. */
export function historyList(store: ChatStore): Conversation[] {
  return store.conversations
    .filter((c) => c.turns.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > TITLE_LENGTH ? `${clean.slice(0, TITLE_LENGTH - 1)}…` : clean;
}

/** «Перейменувати»: власна назва замість першого питання. */
export function rename(store: ChatStore, id: string, title: string): ChatStore {
  return {
    ...store,
    conversations: store.conversations.map((c) =>
      c.id === id ? { ...c, title: truncate(title) || c.title } : c,
    ),
  };
}

/** Для синхронізації (модуль 9c): розмова так, як її приймає API. */
export function toBody(c: Conversation): ChatConversationBody {
  return {
    mode: c.mode,
    title: c.title,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    turns: c.turns as ChatConversationBody["turns"],
  };
}

/**
 * Злиття браузера й акаунта: та сама розмова (id) — новіша перемагає; решта — разом.
 * Повертає новий стан і розмови, яких в акаунті немає чи там вони старіші (їх вивантажити).
 */
export function mergeStores(
  local: ChatStore,
  remote: ChatConversationOut[],
): { store: ChatStore; upload: Conversation[] } {
  const byId = new Map(local.conversations.map((c) => [c.id, c]));
  const remoteIds = new Map(remote.map((r) => [r.id, r.updated_at]));
  for (const r of remote) {
    const mine = byId.get(r.id);
    if (!mine || mine.updatedAt < r.updated_at) {
      byId.set(r.id, {
        id: r.id,
        mode: r.mode,
        title: r.title ?? "",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        turns: r.turns as StoredTurn[],
      });
    }
  }
  const conversations = [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  const upload = conversations.filter(
    (c) => c.turns.length > 0 && (remoteIds.get(c.id) ?? -1) < c.updatedAt,
  );
  return { store: { ...local, conversations }, upload };
}
