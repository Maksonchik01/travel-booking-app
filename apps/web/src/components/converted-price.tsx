import type { ConvertedPrice } from "@tickets/shared";
import { useFormatter, useTranslations } from "next-intl";

import { fractionDigits } from "@/lib/money";

/**
 * Ціна у валюті пошуку, коли джерело дало іншу (модуль 18.2): лише для порівняння, за
 * довідковим курсом ЄЦБ. Основна ціна поруч — вихідна, у валюті продавця; списання — в ній.
 */
export function ConvertedNote({ converted }: { converted?: ConvertedPrice }) {
  const t = useTranslations("currency");
  const format = useFormatter();
  if (!converted) return null;
  const amount = format.number(Number(converted.amount), {
    style: "currency",
    currency: converted.currency,
    currencyDisplay: "narrowSymbol",
    ...fractionDigits(converted.amount),
  });
  return (
    <p
      className="text-muted-foreground text-xs"
      title={t("convertedHint", { currency: converted.original_currency })}
      data-testid="converted-price"
    >
      {t("converted", { amount })}
    </p>
  );
}
