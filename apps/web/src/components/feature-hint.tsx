"use client";

import { Lightbulb, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { HINT_STORAGE_KEY as STORAGE_KEY, type HintId } from "@/lib/hints";

export type { HintId };

function dismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Контекстна підказка до нової складної можливості (етап 9): показується, поки її не закрили
 * (запам'ятовує браузер). Рендерить сервер; закриту до першого кадру ховає CSS за `data-hints`
 * (`lib/hints.ts`), після гідратації — прибираємо з DOM.
 */
export function FeatureHint({ id }: { id: HintId }) {
  const t = useTranslations("hints");
  const [show, setShow] = useState(true);

  useEffect(() => {
    // Що вже закрито — відомо лише браузеру (localStorage); до цього його сховав CSS.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (dismissed().includes(id)) setShow(false);
  }, [id]);

  if (!show) return null;
  return (
    <div
      className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
      role="note"
      data-hint={id}
      data-testid={`hint-${id}`}
    >
      <Lightbulb className="text-primary mt-px size-3.5 shrink-0" aria-hidden />
      <p className="flex-1">{t(id)}</p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed(), id]));
          } catch {
            // без сховища — лише до перезавантаження
          }
          setShow(false);
        }}
        aria-label={t("dismiss")}
        className="hover:bg-background/60 grid size-5 shrink-0 place-items-center rounded"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
