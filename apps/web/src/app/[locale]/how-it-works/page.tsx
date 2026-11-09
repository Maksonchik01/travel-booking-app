import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { LegalPage } from "@/components/legal-page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return { title: t("howItWorks.title") };
}

export default function HowItWorksPage() {
  return <LegalPage page="howItWorks" />;
}
