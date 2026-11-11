"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

/**
 * Кабінет недоступний через збій API чи бази (V3, етап 7): пояснюємо й даємо повторити, а не
 * відправляємо на вхід — сесія при цьому чинна. Помилку вже звітує сервер (Sentry).
 */
export default function AccountError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("account.unavailable");
  const router = useRouter();
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto grid w-full max-w-xl flex-1 place-items-center px-4 py-16 outline-none"
    >
      <div
        role="alert"
        className="bg-card grid justify-items-center gap-3 rounded-xl border px-6 py-10 text-center"
      >
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("text")}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
            className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"
            data-testid="account-retry"
          >
            <RotateCcw className="size-4" aria-hidden />
            {t("retry")}
          </button>
          <Link
            href="/"
            className="hover:border-primary/50 rounded-lg border px-3 py-1.5 text-sm font-medium"
          >
            {t("home")}
          </Link>
        </div>
      </div>
    </main>
  );
}
