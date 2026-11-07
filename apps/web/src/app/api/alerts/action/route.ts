import type { NextRequest } from "next/server";

import { changeAlert } from "@/lib/api";

/**
 * Кнопки сторінки керування (звичайна форма — працює без JS): підтвердити чи вимкнути
 * підписку, і повернутися на ту саму сторінку з результатом.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const action = form.get("action") === "confirm" ? "confirm" : "stop";
  const result = token ? await changeAlert(action, token) : null;
  const done = result?.ok ? action : "failed";
  const url = new URL("/alerts", request.url);
  url.searchParams.set("token", token);
  url.searchParams.set("done", done);
  return Response.redirect(url, 303);
}
