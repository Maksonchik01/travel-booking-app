"use client";

import { Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * «Поділитися» (модуль 20): системний діалог, а без нього — копія посилання. `href` — лише
 * параметри пошуку чи публічний токен поїздки: жодних сесій, `saved=` чи персональних даних.
 */
export function ShareLink({
  href,
  label,
  testId = "share-link",
}: {
  href: string;
  label?: string;
  testId?: string;
}) {
  const t = useTranslations("share");
  const hydrated = useHydrated();
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = new URL(href, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Скасування діалогу «Поділитися» — не помилка.
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={share}
      disabled={!hydrated}
      data-testid={testId}
      data-share-href={href}
    >
      <Share2 className="size-3.5" aria-hidden />
      {copied ? t("copied") : (label ?? t("share"))}
    </Button>
  );
}
