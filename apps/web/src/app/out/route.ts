import { after, type NextRequest } from "next/server";

import { logOutboundClick } from "@/lib/api";
import { isAllowedOutbound, type ClickKind } from "@/lib/outbound";

const SOURCE = /^[a-z0-9_]{1,32}$/;

/** «Забронювати»: перевірка адреси партнера, редирект і облік кліку вже після відповіді. */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const url = params.get("url") ?? "";
  if (!isAllowedOutbound(url)) {
    return new Response("Unknown partner link", { status: 400 });
  }
  const kind: ClickKind = params.get("kind") === "stay" ? "stay" : "flight";
  const source = params.get("source") ?? "";
  if (SOURCE.test(source)) {
    after(() => logOutboundClick({ kind, source, host: new URL(url).hostname }));
  }
  return new Response(null, {
    status: 302,
    // Партнер бачить лише свій marker у посиланні, а не з якої сторінки нашого сайту прийшли.
    headers: { Location: url, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
  });
}
