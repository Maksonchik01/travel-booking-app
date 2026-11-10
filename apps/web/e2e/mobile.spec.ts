import { expect, type Page, test } from "@playwright/test";

/**
 * Мобільна версія (модуль 13.4): на ширині телефона жодна сторінка не прокручується вбік, а
 * фільтри відкриваються окремим вікном. Знімки — у test-results (для ручного перегляду).
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function noHorizontalOverflow(page: Page, name: string) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // Що саме виходить за край — для зрозумілої помилки.
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > width + 1 && getComputedStyle(el).position !== "fixed";
      })
      // Обрізане предком (overflow: hidden/clip/auto) прокрутки не дає.
      .filter((el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== "visible") return false;
        }
        return true;
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    return { scroll: document.documentElement.scrollWidth - width, offenders };
  });
  expect(overflow, `${name}: горизонтальне переповнення`).toEqual({ scroll: 0, offenders: [] });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test("телефон: головна, результати, фільтри у вікні, житло, карта, поїздка, сповіщення", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("search-modes")).toBeVisible();
  await noHorizontalOverflow(page, "home");

  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2");
  await page.getByTestId("offer-card").first().waitFor();
  await noHorizontalOverflow(page, "flights");

  // Фільтри: кнопка з лічильником → вікно → застосувати → вікно закрилось, фільтр в URL.
  await page.getByTestId("filters-open").click();
  const sheet = page.getByTestId("filters-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Лише прямі").check();
  await expect(page).not.toHaveURL(/stops=0/); // у вікні — лише після «Застосувати»
  await sheet.getByRole("button", { name: "Застосувати" }).click();
  await expect(page).toHaveURL(/stops=0/);
  await expect(page.getByTestId("filters-open")).toContainText("1 активний");
  await expect(sheet).toBeHidden();

  await page.getByTestId("offer-card").first().getByText("Деталі маршруту").click();
  await noHorizontalOverflow(page, "flights-details");

  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  await page.getByTestId("stay-card").first().waitFor();
  await noHorizontalOverflow(page, "stays");

  await page.goto("/stays/hotel?city=LIS&in=2026-12-05&out=2026-12-08&src=mock&id=mock-lis-1");
  await page.getByTestId("stay-rates").waitFor();
  await noHorizontalOverflow(page, "stay-hotel");

  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08&view=map");
  await page.getByTestId("stay-map").waitFor();
  await noHorizontalOverflow(page, "stays-map");

  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  await page.getByTestId("trip-card").first().waitFor();
  await noHorizontalOverflow(page, "trip");

  await page.goto("/login");
  await noHorizontalOverflow(page, "login");
  await page.goto("/privacy");
  await noHorizontalOverflow(page, "privacy");
});

test("телефон: кабінет і ШІ-чат", async ({ page }) => {
  await page.goto("/login?mode=register");
  await page.getByLabel("Логін", { exact: true }).fill(`m_${Date.now()}`);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByLabel("Пароль ще раз").fill("password123");
  await page.getByRole("button", { name: "Зареєструватися" }).click();
  await expect(page).toHaveURL(/\/account/);
  for (const section of [
    "",
    "/favorites",
    "/trips",
    "/history",
    "/alerts",
    "/settings",
    "/security",
  ]) {
    await page.goto(`/account${section}`);
    await page.locator("main h2, main h1").first().waitFor();
    await noHorizontalOverflow(page, `account${section.replace("/", "-") || "-overview"}`);
  }
  await page.getByLabel("Пароль для підтвердження").fill("password123");
  await page.getByRole("button", { name: "Видалити акаунт" }).click();

  await page.goto("/");
  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await expect(page.getByText(/Що шукаємо\?/).first()).toBeVisible();
  await noHorizontalOverflow(page, "ai-chat");
});
