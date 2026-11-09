import { type NextRequest, NextResponse } from "next/server";

import { LOCALE_COOKIE, defaultLocale, isLocale } from "@/i18n/config";

/**
 * Мова інтерфейсу без префікса в адресі (модуль 10b): мова з cookie `NEXT_LOCALE` (перемикач
 * у шапці чи профіль), інакше англійська; внутрішній rewrite на `app/[locale]`. Адреси
 * сторінок і всі посилання лишаються як були.
 */
export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookie) ? cookie : defaultLocale;
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${url.pathname === "/" ? "" : url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // API, переходи на партнерів, службові файли й статика — без мови.
  matcher: ["/((?!api|out|_next|maplibre|favicon\\.ico|.*\\..*).*)"],
};
