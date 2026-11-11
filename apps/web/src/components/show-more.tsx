"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import { cameBack, readListPosition, saveListPosition } from "@/lib/list-position";
import { useHydrated } from "@/lib/use-hydrated";

const PAGE = 10;

/**
 * Довга видача частинами по 10. Решта вже відрендерена сервером і лише прихована, тож
 * «Показати ще» миттєве і без запитів. Посилання «До деталей» з «Нашого вибору» на
 * прихований квиток спершу розгортає список, потім прокручує до нього.
 */
export function ShowMore({
  items,
  page = PAGE,
  className = "grid gap-3",
}: {
  items: { key: string; node: ReactNode }[];
  /** Скільки показувати за раз (комбінації поїздки — по 3, модуль 23c). */
  page?: number;
  /** Розкладка списку (напр. сітка карток). */
  className?: string;
}) {
  const t = useTranslations("results");
  const hydrated = useHydrated();
  const [pageLimit, setLimit] = useState(page);
  // Без JS кнопка не працює — до гідратації показуємо все.
  const limit = hydrated ? pageLimit : Number.POSITIVE_INFINITY;
  const list = useRef<HTMLOListElement>(null);
  const restored = useRef(false);

  // Повернення «Назад» з деталей (етап 9): та сама кількість розкритих карток і прокрутка.
  useEffect(() => {
    const key = `${window.location.pathname}${window.location.search}`;
    const saved = readListPosition(key);
    if (saved && saved.limit > page) {
      // Стан зі сховища вкладки — лише після гідратації (на сервері його немає).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLimit(saved.limit);
    }
    if (saved && cameBack()) {
      requestAnimationFrame(() => window.scrollTo({ top: saved.y }));
    }
    restored.current = true;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = readListPosition(key);
        saveListPosition(key, { limit: current?.limit ?? page, y: window.scrollY });
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [page]);

  useEffect(() => {
    if (!restored.current || !Number.isFinite(pageLimit)) return;
    const key = `${window.location.pathname}${window.location.search}`;
    saveListPosition(key, { limit: pageLimit, y: window.scrollY });
  }, [pageLimit]);

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
      <ol ref={list} className={className}>
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
          onClick={() => setLimit((n) => n + page)}
          className="bg-card hover:border-primary/50 hover:text-primary mx-auto h-11 rounded-full px-6 shadow-xs transition-all"
        >
          {t("showMore", { count: Math.min(page, rest), total: rest })}
          <ChevronDown className="size-4" aria-hidden />
        </Button>
      )}
    </>
  );
}
