"use client";

import { Lightbulb, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

const STORAGE_KEY = "tickets.hints.v1";

export type HintId = "flightForm" | "yourTrip" | "explore";

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
 * (запам'ятовує браузер). До гідратації — нічого: сервер не знає, що людина вже бачила.
 */
export function FeatureHint({ id }: { id: HintId }) {
  const t = useTranslations("hints");
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Що вже закрито — відомо лише браузеру (localStorage).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShow(!dismissed().includes(id));
  }, [id]);

  if (!show) return null;
  return (
    <div
      className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
      role="note"
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
