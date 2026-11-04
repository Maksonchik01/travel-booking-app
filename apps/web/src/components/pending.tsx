"use client";

import { Loader2 } from "lucide-react";
import { useLinkStatus } from "next/link";
import { useFormStatus } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * Живий пошук триває 5–15 с, а навігація на ту саму сторінку тримає старі результати,
 * поки не готові нові. Тому показуємо, що запит іде, прямо там, де клікнули.
 */

/** Усередині <Link className="relative">: спінер поверх елемента, поки йде перехід. */
export function LinkPendingOverlay() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span className="bg-background/70 absolute inset-0 grid place-items-center rounded-[inherit]">
      <Loader2 className="size-4 animate-spin" aria-hidden />
    </span>
  );
}

/** Усередині <form>: підпис, поки форма відправляється. */
export function FormPendingNote({ label, className }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <p
      role="status"
      className={cn("text-muted-foreground flex items-center gap-1.5 text-xs", className)}
    >
      {pending && (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {label}
        </>
      )}
    </p>
  );
}
