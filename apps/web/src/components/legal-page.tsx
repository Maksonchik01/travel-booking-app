import { useTranslations } from "next-intl";

import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";

/** Дата останньої правки текстів у `legal.*` (uk.json) — оновлюйте разом із текстом. */
export const LEGAL_UPDATED = "2026-11-11";

type Section = { h: string; p: string[] };

/** Текстова сторінка з `legal.<page>` у uk.json: заголовок, вступ і розділи. */
export function LegalPage({ page }: { page: "terms" | "privacy" | "howItWorks" }) {
  const t = useTranslations("legal");
  const sections = t.raw(`${page}.sections`) as Section[];
  // Публічна адреса для запитів щодо даних (GDPR); без неї рядка контакту немає.
  const contact = process.env.CONTACT_EMAIL;
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main id="main" tabIndex={-1} className="outline-none relative isolate flex-1">
        <HeroBackdrop />
        <article className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8 sm:py-12">
          <header className="grid gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">{t(`${page}.title`)}</h1>
            <p className="text-muted-foreground text-sm">{t("updated", { date: LEGAL_UPDATED })}</p>
            <p className="text-base leading-relaxed">{t(`${page}.intro`)}</p>
          </header>
          {sections.map((section) => (
            <section key={section.h} className="grid gap-2">
              <h2 className="text-lg font-semibold">{section.h}</h2>
              {section.p.map((text) => (
                <p key={text} className="text-muted-foreground text-sm leading-relaxed">
                  {text}
                </p>
              ))}
            </section>
          ))}
          {contact && (
            <p className="text-muted-foreground border-t pt-4 text-xs">
              {t("contact", { contact })}
            </p>
          )}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
