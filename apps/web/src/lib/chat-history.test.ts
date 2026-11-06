import { beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_STORAGE_KEY,
  EMPTY_STORE,
  historyList,
  MAX_CONVERSATIONS,
  newConversation,
  readStore,
  remove,
  upsert,
  withTurns,
  writeStore,
} from "./chat-history";

beforeEach(() => localStorage.clear());

describe("chat history", () => {
  it("назва — перше питання; порожні розмови в історію не потрапляють", () => {
    const empty = newConversation("stays", 1, "a");
    const filled = withTurns(
      newConversation("flights", 2, "b"),
      [
        { role: "user", text: "  Хочу   в Лісабон 10 грудня " },
        { role: "assistant", text: "Звідки летите?" },
      ],
      3,
    );
    const store = upsert(upsert(EMPTY_STORE, empty), filled);

    expect(filled.title).toBe("Хочу в Лісабон 10 грудня");
    expect(historyList(store).map((c) => c.id)).toEqual(["b"]);

    writeStore({ ...store, activeId: "b" });
    const restored = readStore();
    expect(restored.activeId).toBe("b");
    expect(restored.conversations.map((c) => c.id)).toEqual(["b"]);
  });

  it("найновіші вгорі, ліміт кількості, видалення", () => {
    let store = EMPTY_STORE;
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
      const c = withTurns(
        newConversation("flights", i, `c${i}`),
        [{ role: "user", text: `q${i}` }],
        i,
      );
      store = upsert(store, c);
    }
    expect(store.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(historyList(store)[0]!.id).toBe(`c${MAX_CONVERSATIONS + 4}`);

    const removed = remove({ ...store, activeId: "c34" }, "c34");
    expect(removed.activeId).toBeNull();
    expect(removed.conversations.some((c) => c.id === "c34")).toBe(false);
  });

  it("биті чи чужі дані — порожня історія", () => {
    localStorage.setItem(CHAT_STORAGE_KEY, "{not json");
    expect(readStore()).toEqual(EMPTY_STORE);
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({ conversations: [{ id: 1 }, { id: "x", mode: "hotels" }], activeId: "x" }),
    );
    expect(readStore()).toEqual(EMPTY_STORE);
  });
});
