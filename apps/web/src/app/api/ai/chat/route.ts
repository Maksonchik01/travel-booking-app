import type { ChatTurn } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { chatWithAssistant } from "@/lib/api";

const MAX_TURNS = 20;
const MAX_TURN_LENGTH = 2000;
const IATA = /^[A-Za-z]{3}$/;

/** Лише репліки user/assistant з непорожнім текстом, останні MAX_TURNS. */
function cleanMessages(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is ChatTurn =>
        typeof t === "object" &&
        t !== null &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.text === "string" &&
        t.text.trim() !== "",
    )
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_TURN_LENGTH) }))
    .slice(-MAX_TURNS);
}

/** Репліка розмови з агентом: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { messages, current_search, home_airport } = (body ?? {}) as Record<string, unknown>;
  const turns = cleanMessages(messages);
  if (turns.at(-1)?.role !== "user") {
    return Response.json({ error: "the last message must be from the user" }, { status: 400 });
  }
  const home = typeof home_airport === "string" && IATA.test(home_airport) ? home_airport : null;

  // current_search перевіряє API (FlightQuery), тут лише форма.
  const search =
    typeof current_search === "object" && current_search !== null ? current_search : null;
  const result = await chatWithAssistant({
    messages: turns,
    current_search: search as ChatBodySearch,
    home_airport: home,
  });
  if (!result.ok) {
    return Response.json({ status: "unavailable" }, { status: 502 });
  }
  return Response.json(result.data);
}

type ChatBodySearch = Parameters<typeof chatWithAssistant>[0]["current_search"];
