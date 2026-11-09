"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/lib/use-hydrated";

const PAGE = 10;

/**
 * Довга видача частинами по 10. Решта вже відрендерена сервером і лише прихована, тож
 * «Показати ще» миттєве і без запитів. Посилання «До деталей» з «Нашого вибору» на
 * прихований квиток спершу розгортає список, потім прокручує до нього.
 */
export function ShowMore({ items }: { items: { key: string; node: ReactNode }[] }) {
  const t = useTranslations("results");
  const hydrated = useHydrated();
  const [pageLimit, setLimit] = useState(PAGE);
  // Без JS кнопка не працює — до гідратації показуємо все.
  const limit = hydrated ? pageLimit : Number.POSITIVE_INFINITY;
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
      const target = link && document.getElementById(link.hash.slice(1));
      if (!target || !list.current?.contains(target) || !target.hidden) return;
      event.preventDefault();
      flushSync(() => setLimit(Number.POSITIVE_INFINITY));
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", link.hash);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const rest = items.length - limit;
  return (
    <>
      <ol ref={list} className="grid gap-3">
        {items.map((item, i) => (
          <li
            key={item.key}
            id={item.key}
            hidden={i >= limit}
            // content-visibility: картки нижче екрана браузер не верстає й не малює, поки до них
            // не догорнули — довга видача не гальмує телефон (модуль 17.5).
            className="animate-in fade-in-0 slide-in-from-bottom-2 scroll-mt-20 duration-300 [contain-intrinsic-size:auto_16rem] [content-visibility:auto]"
          >
            {item.node}
          </li>
        ))}
      </ol>
      {rest > 0 && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setLimit((n) => n + PAGE)}
          className="bg-card hover:border-primary/50 hover:text-primary mx-auto h-11 rounded-full px-6 shadow-xs transition-all"
        >
          {t("showMore", { count: Math.min(PAGE, rest), total: rest })}
          <ChevronDown className="size-4" aria-hidden />
        </Button>
      )}
    </>
  );
}
