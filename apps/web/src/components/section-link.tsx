"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

import { lastSearch, type SearchMode } from "@/lib/search-modes";

/**
 * Розділ у шапці (модуль 23b): повертає до останнього пошуку розділу в цій вкладці — з обраним
 * рейсом і житлом, — а не на порожню форму. Без JS чи історії — звичайне посилання.
 */
export function SectionLink({
  section,
  ...props
}: ComponentProps<typeof Link> & { section: SearchMode }) {
  const router = useRouter();
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        const last = lastSearch(section);
        if (!last) return;
        event.preventDefault();
        router.push(last);
      }}
    />
  );
}
