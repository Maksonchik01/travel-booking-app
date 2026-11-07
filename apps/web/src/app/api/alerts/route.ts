import type { AlertCreate } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { createAlert } from "@/lib/api";

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
  const result = await createAlert(body as AlertCreate);
  if (!result.ok) {
    return Response.json(
      { error: result.reason },
      { status: result.reason === "error" ? 422 : 502 },
    );
  }
  return Response.json(result.data, { status: 201 });
}
