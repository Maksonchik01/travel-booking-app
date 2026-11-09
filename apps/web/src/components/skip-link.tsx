"use client";

import { useTranslations } from "next-intl";

/**
 * «Перейти до вмісту» (WCAG 2.4.1): невидиме, доки на ньому немає фокусу (перший Tab).
 * Попередні сторінки лишаються змонтованими прихованими — тож фокусуємо ВИДИМИЙ `main`;
 * без JS спрацює звичайне `#main`.
 */
export function SkipLink() {
  const t = useTranslations("nav");
  return (
    <a
      href="#main"
      onClick={(event) => {
        const main = [...document.querySelectorAll<HTMLElement>("main")].find(
          (el) => el.offsetParent !== null || el.getClientRects().length > 0,
        );
        if (!main) return;
        event.preventDefault();
        main.focus();
        main.scrollIntoView();
      }}
      className="bg-primary text-primary-foreground sr-only z-[60] rounded-lg px-4 py-2 text-sm font-medium shadow-lg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      {t("skipToContent")}
    </a>
  );
}
