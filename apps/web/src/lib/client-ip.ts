// Лише для сервера: next/headers недоступний у клієнтському коді.
import { cookies, headers } from "next/headers";

/** Токен сесії — лише в httpOnly-cookie: JavaScript сторінки його не бачить. */
export const SESSION_COOKIE = "tickets_session";

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

/**
 * Пошукові запити від імені відвідувача: IP і, якщо він увійшов, його сесія — API рахує
 * ліміти дорогих операцій на акаунт, а не на IP (core/rate_limit.py, ADR 0056).
 */
export async function clientIdentityHeaders(): Promise<Record<string, string>> {
  const base = await clientIpHeaders();
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    return token ? { ...base, authorization: `Bearer ${token}` } : base;
  } catch {
    return base;
  }
}
