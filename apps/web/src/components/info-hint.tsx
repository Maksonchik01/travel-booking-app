import { Info } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Пояснення третього рівня (модуль 23e): коротке «Як рахуємо?» біля заголовка, текст — під
 * спойлером, а не абзацом над результатами. Працює без JS (`<details>`).
 */
export function InfoHint({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details className="group text-xs" data-testid={testId}>
      <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1.5 rounded select-none">
        <Info className="size-3.5 shrink-0" aria-hidden />
        {label}
      </summary>
      <div className="text-muted-foreground mt-2 grid max-w-2xl gap-1.5">{children}</div>
    </details>
  );
}
