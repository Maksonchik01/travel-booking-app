"use client";

import type { SearchKind } from "@tickets/shared";
import { Loader2, Star } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import { type FormState, saveSearch } from "@/app/actions/account";
import { saveGuestSearch } from "@/lib/guest-searches";
import { cn } from "@/lib/utils";

const IDLE: FormState = { status: "idle" };

/** «Зберегти пошук» (☆): у кабінеті → «Збережене»; гість — у цьому браузері (етап 7). */
export function SaveSearch({
  kind,
  params,
  title,
  back,
}: {
  kind: SearchKind;
  params: string;
  title: string;
  /** Адреса цієї сторінки — повернутися після входу. */
  back: string;
}) {
  const t = useTranslations("saveSearch");
  const [state, action] = useActionState(saveSearch, IDLE);
  // Гість (етап 7): пошук — у цьому браузері; після входу запропонуємо перенести в акаунт.
  const [local, setLocal] = useState<"saved" | "full" | null>(null);
  useEffect(() => {
    if (state.status !== "guest") return;
    const saved = saveGuestSearch({ kind, params, title });
    // Відповідь дії — зовнішня подія для цього стану (localStorage), а не похідне значення.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal(saved ? "saved" : "full");
  }, [state, kind, params, title]);
  if (local === "saved") {
    return (
      <Link
        href="/favorites#searches"
        className="bg-accent text-accent-foreground flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-primary hover:text-primary-foreground"
        data-testid="save-search-local"
      >
        <Star className="size-4 fill-current" aria-hidden />
        {t("savedLocal")}
      </Link>
    );
  }
  if (state.status === "ok") {
    return (
      <Link
        href="/account#saved"
        className="bg-accent text-accent-foreground flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-primary hover:text-primary-foreground"
      >
        <Star className="size-4 fill-current" aria-hidden />
        {t("saved")}
      </Link>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="params" value={params} />
      <input type="hidden" name="title" value={title} />
      <input type="hidden" name="back" value={back} />
      <SaveButton label={t("save")} />
      {local === "full" && (
        <span role="alert" className="text-xs text-warning">
          {t("limit")}
        </span>
      )}
      {state.status === "error" && (
        <span role="alert" className="text-xs text-warning">
          {t(state.code === "limit_reached" ? "limit" : "error")}
        </span>
      )}
    </form>
  );
}

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "bg-card hover:border-primary/50 hover:text-primary flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium shadow-xs transition-colors",
      )}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Star className="size-4" aria-hidden />
      )}
      {label}
    </button>
  );
}
