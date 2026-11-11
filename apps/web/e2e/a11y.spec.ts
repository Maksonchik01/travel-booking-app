import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Доступність (модуль 13.5): axe-core за WCAG 2.1 A/AA на ключових сторінках — контраст,
 * підписи полів, ролі й назви елементів, структура. Падаємо на «serious» і «critical».
 */
const PAGES = [
  ["home", "/"],
  ["flights", "/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2"],
  ["stays", "/stays?city=LIS&in=2026-12-05&out=2026-12-08"],
  ["stays-map", "/stays?city=LIS&in=2026-12-05&out=2026-12-08&view=map"],
  ["stay-hotel", "/stays/hotel?city=LIS&in=2026-12-05&out=2026-12-08&src=mock&id=mock-lis-1"],
  ["trip", "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08"],
  ["explore", "/explore?from=WAW&depart=2026-12-01&until=2026-12-31&nmin=2&nmax=4"],
  ["explore-start", "/explore?from=WAW"],
  ["explore-map", "/explore?from=WAW&depart=2026-12-01&until=2026-12-31&nmin=2&nmax=4&view=map"],
  ["login", "/login"],
  ["privacy", "/privacy"],
  ["how-it-works", "/how-it-works"],
  ["favorites", "/favorites"],
  ["trips", "/trips"],
] as const;

async function audit(page: Page, name: string) {
  // content-visibility: auto (довгі списки, модуль 17.5) — браузер не малює картки за екраном,
  // і axe не бачить їхніх кольорів. Вигляд від цього не змінюється, тож для аудиту — вимикаємо;
  // разом з анімаціями: інакше щойно показані картки ще напівпрозорі (fade-in) — хибний контраст.
  await page.addStyleTag({
    content:
      "*, *::before, *::after { content-visibility: visible !important; animation: none !important; transition: none !important; }",
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Карта (MapLibre) — полотно з власною клавіатурною навігацією; список поруч дублює її.
    .exclude(".maplibregl-canvas-container")
    .analyze();
  const serious = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 4)
          .join(" | ")}`,
    );
  expect.soft(serious, `${name}: порушення доступності`).toEqual([]);
}

for (const [width, label] of [
  [1280, "desktop"],
  [390, "phone"],
] as const) {
  test(`доступність (${label}): ключові сторінки без серйозних порушень`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of PAGES) {
      await page.goto(path);
      await page.locator("main").waitFor();
      await page.waitForLoadState("networkidle");
      await audit(page, `${label}/${name}`);
    }
  });
}

test("доступність: темна тема — контраст статусів і тексту", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  for (const [name, path] of PAGES.slice(0, 5)) {
    await page.goto(path);
    await page.locator("main").waitFor();
    await page.waitForLoadState("networkidle");
    await audit(page, `dark/${name}`);
  }
});

test("доступність: кабінет і сторінка підписки", async ({ page }) => {
  await page.goto("/login?mode=register");
  await page.getByLabel("Логін", { exact: true }).fill(`a11y_${Date.now()}`);
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
    await page.waitForLoadState("networkidle");
    await audit(page, `account${section || "/overview"}`);
  }
  await page.getByLabel("Пароль для підтвердження").fill("password123");
  await page.getByRole("button", { name: "Видалити акаунт" }).click();
});

test("клавіатура: перший Tab — «Перейти до вмісту», фокус видно", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Перейти до вмісту" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("клавіатура: вікно фільтрів на телефоні — фокус усередині, Escape повертає на кнопку", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12");
  await page.getByTestId("offer-card").first().waitFor();
  const open = page.getByTestId("filters-open");
  await open.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: /Фільтри/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Закрити фільтри" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(open).toBeFocused();
});

test("безпека: заголовки на сторінках і без перенаправлення на чужий сайт після входу", async ({
  page,
}) => {
  const response = await page.goto("/");
  const headers = response!.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-powered-by"]).toBeUndefined();

  // `/\evil` браузер читає як `//evil` — у формі входу лишається безпечний шлях.
  await page.goto("/login?next=/%5Cevil.example");
  await expect(page.locator('input[name="next"]').first()).toHaveValue("/account");
});

test("розділ власника /ops: лише адмін, зведення, зміна ліміту, доступність", async ({ page }) => {
  // Звичайний відвідувач — сторінка «не знайдено», жодних даних зведення (notFound() у стрімінгу
  // віддає вміст 404 зі статусом 200 — перевіряємо вміст).
  await page.goto("/ops");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ops")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Бюджети платних API");

  // Адмін (OPS_ADMINS у playwright.config): реєстрація або вхід, якщо вже є з минулого прогону.
  await page.goto("/login?mode=register");
  await page.getByLabel("Логін", { exact: true }).fill("e2e_ops_admin");
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByLabel("Пароль ще раз").fill("password123");
  await page.getByRole("button", { name: "Зареєструватися" }).click();
  if (!/\/account/.test(page.url())) {
    await page.waitForTimeout(500);
    if (!/\/account/.test(page.url())) {
      await page.goto("/login");
      await page.getByLabel("Логін або email").fill("e2e_ops_admin");
      await page.getByLabel("Пароль", { exact: true }).fill("password123");
      await page.getByRole("button", { name: "Увійти", exact: true }).click();
    }
  }
  await expect(page).toHaveURL(/\/account/);

  await page.goto("/ops");
  const ops = page.getByTestId("ops");
  await expect(ops).toContainText("Бюджети платних API");
  await expect(ops).toContainText("serpapi");

  const form = page.getByTestId("ops-budget-form");
  await form.locator('select[name="period"]').selectOption("month");
  await form.locator('input[name="limit"]').fill("123");
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(page.getByRole("status")).toContainText("Ліміт збережено");
  await expect(ops.locator("tr", { hasText: "serpapi" })).toContainText("/ 123");
  // Назад до значення з конфігу — інші прогони не зачіпає.
  await form.locator('select[name="period"]').selectOption("month");
  await form.locator('input[name="reset"]').check();
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(page.getByRole("status")).toContainText("Ліміт збережено");

  // Телефон: таблиці прокручуються у своїх контейнерах, сторінка — ні.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 720 });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
});
