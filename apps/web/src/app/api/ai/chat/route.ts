import type { ChatBody, ChatMode, ChatTurn } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { chatWithAssistant } from "@/lib/api";

const MAX_TURNS = 20;
const MAX_TURN_LENGTH = 2000;
const IATA = /^[A-Za-z]{3}$/;
const MODES: readonly ChatMode[] = ["flights", "stays", "trip"];

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
  const { messages, mode, current_search, current_stay_search, home_airport } = (body ??
    {}) as Record<string, unknown>;
  const turns = cleanMessages(messages);
  if (turns.at(-1)?.role !== "user") {
    return Response.json({ error: "the last message must be from the user" }, { status: 400 });
  }
  const home = typeof home_airport === "string" && IATA.test(home_airport) ? home_airport : null;

  // Поточні пошуки перевіряє API (FlightQuery, StayQuery), тут лише форма.
  const object = (value: unknown) => (typeof value === "object" && value !== null ? value : null);
  const result = await chatWithAssistant({
    messages: turns,
    mode: MODES.find((m) => m === mode) ?? "flights",
    current_search: object(current_search) as ChatBody["current_search"],
    current_stay_search: object(current_stay_search) as ChatBody["current_stay_search"],
    home_airport: home,
  });
  if (!result.ok) {
    if (result.reason === "rate_limited") {
      return Response.json({ status: "rate_limited" }, { status: 429 });
    }
    return Response.json({ status: "unavailable" }, { status: 502 });
  }
  return Response.json(result.data);
}
