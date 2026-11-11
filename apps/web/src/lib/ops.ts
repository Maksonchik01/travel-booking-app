// Лише для сервера: ключ INTERNAL_API_KEY у браузер не потрапляє (server-boundary.test).
import type { Account, BudgetLimit, OpsSummary } from "@tickets/shared";

import { API_URL } from "@/lib/session";

/**
 * Технічний розділ власника `/ops` (V3, етап 10, ADR 0062). Доступ — логіни з `OPS_ADMINS`
 * (через кому, env вебу); решта бачить 404. Дані — `GET /ops/summary` API з INTERNAL_API_KEY,
 * зміна лімітів — `PUT /ops/budgets`. Без ключа чи списку адмінів розділу немає.
 */
export function isOpsAdmin(account: Account | null): boolean {
  if (!account || !process.env.INTERNAL_API_KEY) return false;
  const admins = (process.env.OPS_ADMINS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(account.username.toLowerCase());
}

function ownerHeaders(): Record<string, string> {
  return { "x-internal-key": process.env.INTERNAL_API_KEY ?? "" };
}

export async function fetchOpsSummary(): Promise<OpsSummary | null> {
  try {
    const response = await fetch(`${API_URL}/ops/summary`, {
      headers: ownerHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok ? ((await response.json()) as OpsSummary) : null;
  } catch {
    return null;
  }
}

export async function putBudget(body: BudgetLimit): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/ops/budgets`, {
      method: "PUT",
      headers: { ...ownerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
