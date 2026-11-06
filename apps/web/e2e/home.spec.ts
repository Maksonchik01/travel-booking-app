import { expect, test } from "@playwright/test";

// API у e2e працює з mock-провайдером (див. playwright.config.ts): дані детерміновані,
// тож перевіряємо конкретні результати, а не «будь-що».

test("головна українською з формою пошуку і станом сервісів", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Знайдіть переліт, який справді вигідний",
  );
  await expect(page.getByLabel("Звідки")).toBeVisible();
  await expect(page.getByText(/Стан сервісів|API недоступний/)).toBeVisible();
});

test("пошук: підказки міст → результати → фільтри → календар", async ({ page }) => {
  await page.goto("/");
  // Підказки працюють після гідратації (приховане поле з кодом з'являється тоді ж).
  await page.locator('input[type="hidden"][name="from"]').waitFor({ state: "attached" });

  await page.getByLabel("Звідки").fill("варш");
  await page.getByRole("option", { name: /Варшава, Фредерік Шопен/ }).click();
  await expect(page.getByLabel("Звідки")).toHaveValue("Варшава, Фредерік Шопен");
  await page.getByLabel("Куди").fill("lis");
  await page.getByLabel("Куди").press("ArrowDown");
  await page.getByLabel("Куди").press("ArrowUp");
  await page.getByLabel("Куди").press("Enter");
  await page.getByLabel("Виліт").fill("2026-12-05");
  await page.getByRole("button", { name: "Шукати" }).click();

  await expect(page).toHaveURL(/from=WAW&to=LIS/);
  const cards = page.getByTestId("offer-card");
  await expect(cards).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "WAW → LIS" })).toBeVisible();
  await expect(page.getByTestId("price").first()).toContainText("€");
  await expect(page.getByRole("heading", { name: "Наш вибір" })).toBeVisible();
  await expect(page.locator('[data-testid="top-pick"][data-label="balanced"]')).toHaveCount(1);
  await expect(page.getByTestId("airlines").first()).toContainText("LOT Polish");

  // Розбивка оцінки в будь-якій картці.
  await cards.first().getByText("Чому така оцінка?").click();
  await expect(cards.first().getByTestId("breakdown")).toBeVisible();

  // Фільтр застосовується одразу і не губить маршрут.
  await page.getByRole("radio", { name: "Лише прямі" }).check();
  await expect(page).toHaveURL(/stops=0/);
  await expect(page).toHaveURL(/from=WAW/);
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 варіант з 4")).toBeVisible();
  await page.getByRole("link", { name: "Скинути фільтри" }).click();
  await expect(cards).toHaveCount(4);

  // Сортування за оцінкою.
  await page.getByRole("link", { name: "Вигідніші" }).click();
  await expect(page).toHaveURL(/sort=score/);

  // Інший день у календарі — новий пошук.
  await page.locator('[data-testid="calendar-day"]:not([aria-current])').first().click();
  await expect(page).not.toHaveURL(/depart=2026-12-05/);
  await expect(cards.first()).toBeVisible();
});

test("розмова з ШІ-помічником: питання → відповідь → результати, контекст не губиться", async ({
  page,
}) => {
  await page.goto("/");
  // Поле активне після гідратації (до неї розмову не відновити з sessionStorage).
  await page.waitForLoadState("networkidle");

  const box = page.getByLabel("Запитайте ШІ-помічника");
  const send = page.getByRole("button", { name: "Надіслати" });
  const conversation = page.getByRole("list", { name: "Розмова з помічником" });

  // Одне слово — mock-агент перепитує (див. tickets_api/llm/mock.py).
  await box.fill("Лісабон");
  await send.click();
  await expect(conversation).toContainText("Куди і коли ви хочете полетіти?");

  // Відповідь разом із попередньою реплікою — пошук WAW → LIS.
  await box.fill("з Варшави");
  await send.click();
  await expect(page).toHaveURL(/from=WAW&to=LIS&depart=\d{4}-\d{2}-\d{2}/);
  await expect(conversation).toContainText("Знайшов варіанти");
  await expect(conversation).toContainText("EUR");
  await expect(page.getByTestId("offer-card").first()).toBeVisible();
  const explanation = page.getByTestId("ai-explanation");
  await expect(explanation).toContainText("Радимо:");

  // Після переходу на результати розмова на місці, і її видно після оновлення вкладки.
  await page.reload();
  await expect(conversation).toContainText("Куди і коли ви хочете полетіти?");
  await page.getByRole("button", { name: "Нова розмова" }).click();
  await expect(conversation).toHaveCount(0);
});
