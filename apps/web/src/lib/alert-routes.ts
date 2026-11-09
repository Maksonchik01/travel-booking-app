import type { NextRequest } from "next/server";

/** Кабінет — у розділ сповіщень; посилання — на ту саму сторінку (після видалення — без токена). */
export function backUrl(
  request: NextRequest,
  form: FormData,
  token: string,
  done: string,
  deleted = false,
): URL {
  if (form.get("back") === "account") {
    const url = new URL("/account/alerts", request.url);
    const failed = done === "failed" || done === "editFailed";
    url.searchParams.set(failed ? "error" : "done", `alert_${done}`);
    return url;
  }
  const url = new URL("/alerts", request.url);
  if (!(deleted && done !== "failed")) url.searchParams.set("token", token);
  url.searchParams.set("done", done);
  return url;
}
