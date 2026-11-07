import type { AlertCreate, AlertCreated } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { call } from "@/lib/session";

/** Створення підписки: браузер ходить сюди, а не напряму в API. Перевіряє API. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  // З сесією (якщо увійшли) — підписка з'явиться в кабінеті.
  const result = await call<AlertCreated>("POST", "/alerts", body as AlertCreate);
  if (!result.ok) {
    return Response.json({ error: result.code }, { status: result.status === 0 ? 502 : 422 });
  }
  return Response.json(result.data, { status: 201 });
}
