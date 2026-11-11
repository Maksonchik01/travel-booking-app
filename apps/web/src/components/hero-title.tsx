import { useTranslations } from "next-intl";

/**
 * Заголовок стартової сторінки пошуку. Синхронний: той самий і в статичній оболонці
 * (`ShellChoice`), і після завантаження — без зсуву.
 */
export function HeroTitle({
  namespace,
  children,
}: {
  namespace: "home" | "staysHome" | "tripHome" | "explore";
  children?: React.ReactNode;
}) {
  const t = useTranslations(namespace);
  return (
    <div className="grid gap-1.5">
      <h1 className="text-2xl font-bold tracking-tight text-balance sm:text-4xl">
        {t.rich("title", {
          accent: (chunks) => (
            <span className="from-primary bg-gradient-to-r to-sky-500 bg-clip-text text-transparent">
              {chunks}
            </span>
          ),
        })}
      </h1>
      <p className="text-muted-foreground max-w-2xl text-sm text-balance sm:text-base">
        {t("subtitle")}
      </p>
      {children}
    </div>
  );
}
