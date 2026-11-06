import type { Leg, Offer } from "@tickets/shared";
import Image from "next/image";

import { cn } from "@/lib/utils";

/** Перевізники відрізка: з сегментів, а якщо їх немає (кешовані джерела) — усієї пропозиції. */
export function legCarriers(leg: Leg, offer: Offer): string[] {
  const codes = leg.segments?.map((s) => s.carrier) ?? offer.airlines;
  return [...new Set(codes)].filter((code) => code && code !== "?");
}

/**
 * Логотип авіакомпанії з відповіді провайдера (через оптимізатор Next — без запитів браузера
 * до сторонніх хостів). Немає логотипа — кружечок з кодом у сталому відтінку синього.
 */
export function AirlineLogo({
  code,
  url,
  size = 20,
  className,
}: {
  code: string;
  url?: string | null;
  size?: number;
  className?: string;
}) {
  if (url) {
    return (
      <Image
        src={url}
        alt=""
        width={size}
        height={size}
        // Логотипи прозорі й часто темні — біла підкладка, щоб їх було видно й у темній темі.
        className={cn(
          "shrink-0 rounded-full bg-white object-contain ring-1 ring-border",
          className,
        )}
        data-testid="airline-logo"
      />
    );
  }
  return (
    <span
      aria-hidden
      data-testid="airline-monogram"
      style={{ width: size, height: size, "--logo-hue": hue(code) } as React.CSSProperties}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-[oklch(0.93_0.04_var(--logo-hue))] text-[9px] font-semibold tracking-tight text-slate-700 ring-1 ring-border dark:bg-[oklch(0.36_0.07_var(--logo-hue))] dark:text-slate-100",
        className,
      )}
    >
      {code.slice(0, 2)}
    </span>
  );
}

/** Сталий відтінок у синьо-фіолетовому діапазоні — однакова компанія виглядає однаково. */
function hue(code: string): number {
  let sum = 0;
  for (const char of code) sum = (sum * 31 + char.charCodeAt(0)) % 997;
  return 200 + (sum % 90);
}
