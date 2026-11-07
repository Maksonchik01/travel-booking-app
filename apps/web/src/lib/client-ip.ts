// Лише для сервера: next/headers недоступний у клієнтському коді.
import { headers } from "next/headers";

/**
 * Заголовки, з якими API рахує ліміти на відвідувача, а не на сервер Vercel (core/rate_limit.py).
 * Vercel сам ставить x-real-ip / x-forwarded-for і не дає клієнту їх підмінити.
 * API вірить IP лише з INTERNAL_API_KEY; без ключа чи поза запитом — нічого не додаємо.
 */
export async function clientIpHeaders(): Promise<Record<string, string>> {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return {};
  try {
    const incoming = await headers();
    const ip = incoming.get("x-real-ip") ?? incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
    return ip ? { "x-client-ip": ip, "x-internal-key": key } : {};
  } catch {
    return {};
  }
}
