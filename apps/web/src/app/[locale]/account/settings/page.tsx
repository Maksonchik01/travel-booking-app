import type { Account } from "@tickets/shared";
import { useTranslations } from "next-intl";
import { getLocale } from "next-intl/server";

import { ProfileForm } from "@/components/account-forms";
import { AccountPage, Section, requireAccount } from "@/components/account-shell";
import { AvatarForm, PreferencesForm, SearchPrefsForm } from "@/components/profile-forms";
import { isLocale, defaultLocale, type Locale } from "@/i18n/config";
import { fetchCountryCodes } from "@/lib/api";

/** Кабінет → «Налаштування»: профіль, мова й регіон, особисті налаштування пошуку (10b). */
export default function SettingsPage({ searchParams }: PageProps<"/[locale]/account/settings">) {
  return (
    <AccountPage section="settings" searchParams={searchParams}>
      <Settings />
    </AccountPage>
  );
}

async function Settings() {
  const [{ account }, codes, current] = await Promise.all([
    requireAccount("settings"),
    fetchCountryCodes(),
    getLocale(),
  ]);
  const locale: Locale = isLocale(current) ? current : defaultLocale;
  // Назви країн мовою сторінки — тут, на сервері: однаковий текст і для SSR, і для браузера.
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const collator = new Intl.Collator(locale);
  const countries = codes
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return <Sections account={account} countries={countries} locale={locale} />;
}

function Sections({
  account,
  countries,
  locale,
}: {
  account: Account;
  countries: { code: string; name: string }[];
  locale: Locale;
}) {
  const t = useTranslations("account");
  return (
    <>
      <Section id="profile" title={t("nav.profile")} hint={t("profileHint")}>
        <AvatarForm account={account} />
        <ProfileForm account={account} />
      </Section>
      <Section id="regional" title={t("profile.title")} hint={t("profile.hint")}>
        <PreferencesForm account={account} countries={countries} locale={locale} />
      </Section>
      <Section id="search-prefs" title={t("prefs.title")} hint={t("prefs.hint")}>
        <SearchPrefsForm account={account} />
      </Section>
    </>
  );
}
