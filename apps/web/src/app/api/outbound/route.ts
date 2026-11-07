import { after, type NextRequest } from "next/server";

import { logOutboundClick } from "@/lib/api";

const SOURCE = /^[a-z0-9_]{1,32}$/;
const HOSTS = new Set(["www.google.com"]);

/**
 * Облік переходу, коли браузер іде до продавця не через `/out` (POST-перехід Google з варіантів
 * бронювання). Лише відомі хости; відповідь — одразу, запис — після неї.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const source = typeof body?.source === "string" ? body.source : "";
  const host = typeof body?.host === "string" ? body.host : "";
  if (SOURCE.test(source) && HOSTS.has(host)) {
    after(() => logOutboundClick({ kind: "flight", source, host }));
  }
  return new Response(null, { status: 204 });
}
