"use client";

import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

const STORAGE_KEY = "tickets.tripHistory.v1";
const MAX_STEPS = 20;

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(steps: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(steps.slice(-MAX_STEPS)));
  } catch {
    // Приватний режим — без «повернути»: лишається кнопка «Назад» браузера.
  }
}

/**
 * «Повернути попередній вибір» (модуль 8b). Кожен стан поїздки — це URL, тож історія — стек
 * рядків запиту у sessionStorage вкладки. Компонент записує поточний стан і, якщо є куди,
 * показує кнопку повернення.
 */
export function TripUndo({ params, showButton }: { params: string; showButton: boolean }) {
  const t = useTranslations("tripBuilder");
  const router = useRouter();
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    const steps = read();
    if (steps.at(-1) !== params) steps.push(params);
    write(steps);
    // Стан із sessionStorage — лише після гідратації.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrevious(steps.length > 1 ? steps[steps.length - 2] : null);
  }, [params]);

  if (!showButton || previous === null) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        const steps = read();
        steps.pop();
        write(steps);
        router.push(`/trip?${steps.at(-1) ?? previous}`, { scroll: false });
      }}
      data-testid="trip-undo"
    >
      <Undo2 className="size-3.5" aria-hidden />
      {t("undo")}
    </Button>
  );
}
