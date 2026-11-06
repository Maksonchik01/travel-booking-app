import { Suspense } from "react";
import { useTranslations } from "next-intl";

import { ServiceStatus } from "@/components/service-status";
import { fetchReadiness } from "@/lib/api";

/** М'яке синє сяйво й пунктир маршруту за пошуком — лише декор. */
export function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="from-primary/[0.08] absolute inset-0 bg-gradient-to-b via-sky-500/[0.03] to-transparent" />
      <div className="bg-primary/20 absolute -top-24 -right-24 size-80 rounded-full blur-3xl" />
      <div className="absolute -top-16 left-1/3 size-64 rounded-full bg-sky-400/15 blur-3xl" />
      <svg
        className="text-primary/20 absolute top-6 right-0 hidden h-40 w-[34rem] md:block"
        viewBox="0 0 540 160"
        fill="none"
      >
        <path
          d="M10 150 C 160 20, 380 10, 530 60"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="6 8"
        />
      </svg>
    </div>
  );
}

export function SiteFooter() {
  const t = useTranslations("footer");
  return (
    <footer className="bg-card/60 border-t">
      <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs">
        <p>{t("disclaimer")}</p>
        <Suspense fallback={null}>
          <FooterStatus />
        </Suspense>
      </div>
    </footer>
  );
}

async function FooterStatus() {
  return <ServiceStatus status={await fetchReadiness()} compact />;
}
