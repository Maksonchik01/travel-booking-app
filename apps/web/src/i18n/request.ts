import { getRequestConfig } from "next-intl/server";

import { defaultLocale } from "./config";

// Поки одна мова: локаль фіксована, без префіксів у URL.
// Коли додамо інші мови — визначатимемо її тут (cookie / Accept-Language).
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
