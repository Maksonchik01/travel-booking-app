import type { NextRequest } from "next/server";

import { backUrl } from "@/lib/alert-routes";
import { type AlertAction, changeAlert } from "@/lib/api";

const ACTIONS: readonly AlertAction[] = ["confirm", "stop", "pause", "resume", "delete"];

/**
 * Кнопки керування підпискою (звичайна форма — працює без JS): підтвердити, вимкнути,
 * призупинити, відновити, видалити — і повернутися туди, звідки натиснули, з результатом.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const action = ACTIONS.find((a) => a === form.get("action")) ?? "stop";
  const result = token ? await changeAlert(action, token) : null;
  const done = result?.ok ? action : "failed";
  return Response.redirect(backUrl(request, form, token, done, action === "delete"), 303);
}
