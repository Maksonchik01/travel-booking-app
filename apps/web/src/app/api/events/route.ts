import type { EventIn } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/api";

/**
 * Анонімні події з браузера (модуль 19) — у API. Форму перевіряє API (перелік подій і міток);
 * відповідь завжди 204: аналітика нічого не повідомляє сторінці й нічого не ламає.
 */
export async function POST(request: NextRequest) {
  if (request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1") {
    return new Response(null, { status: 204 });
  }
  const body = (await request.json().catch(() => null)) as EventIn | null;
  if (body && typeof body.name === "string") await recordEvent(body);
  return new Response(null, { status: 204 });
}
