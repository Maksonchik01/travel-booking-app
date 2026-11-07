"use client";

import type { SearchKind } from "@tickets/shared";
import { Loader2, Star } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { type FormState, saveSearch } from "@/app/actions/account";
import { cn } from "@/lib/utils";

const IDLE: FormState = { status: "idle" };

/** «Зберегти пошук» (☆): у кабінеті → «Збережене». Гість потрапить на вхід і назад. */
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
      {state.status === "error" && (
        <span role="alert" className="text-xs text-amber-700 dark:text-amber-400">
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
