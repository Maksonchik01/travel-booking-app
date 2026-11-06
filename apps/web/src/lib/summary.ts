import { getFormatter, getTranslations } from "next-intl/server";

/** Короткий підсумок пошуку для згорнутої форми на мобільному: «5 груд. – 8 груд.». */
export async function dateRange(from: string, to?: string | null): Promise<string> {
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return to ? `${date(from)} – ${date(to)}` : date(from);
}

export async function peopleCount(adults: number, children = 0): Promise<string> {
  const t = await getTranslations("search");
  const grown = t("adultsCount", { count: adults });
  return children ? `${grown}, ${t("childrenCount", { count: children })}` : grown;
}
