"use server";

import type { BudgetLimit } from "@tickets/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isOpsAdmin, putBudget } from "@/lib/ops";
import { currentAccount } from "@/lib/session";

const ACCOUNTS = ["serpapi", "scrapedo"] as const;
const PERIODS = ["hour", "day", "month"] as const;

/** Ліміт платного API з розділу `/ops` (ADR 0062): лише адмін, значення перевіряє ще й API. */
export async function setBudget(form: FormData): Promise<void> {
  if (!isOpsAdmin(await currentAccount())) redirect("/");
  const account = ACCOUNTS.find((a) => a === form.get("account"));
  const period = PERIODS.find((p) => p === form.get("period"));
  if (!account || !period) redirect("/ops?error=invalid");
  const raw = String(form.get("limit") ?? "").trim();
  const reset = form.get("reset") === "1";
  const limit = raw === "" ? null : Number.parseInt(raw, 10);
  if (!reset && limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    redirect("/ops?error=invalid");
  }
  const body: BudgetLimit = { account, period, limit, reset };
  const ok = await putBudget(body);
  revalidatePath("/ops");
  redirect(ok ? "/ops?done=budget" : "/ops?error=failed");
}
