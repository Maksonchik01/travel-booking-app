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
  // Новий пошук — «туди й назад» за замовчуванням; тут — в один бік.
  await expect(page.getByLabel("Повернення")).toBeEnabled();
  await page.getByText("В один бік").click();
  await expect(page.getByLabel("Повернення")).toBeDisabled();
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

  // Помічник — друга вкладка картки пошуку; спершу він питає, що шукаємо.
  await page.getByRole("tab", { name: "ШІ-помічник" }).click();
  await expect(page.getByText("Що шукаємо?")).toBeVisible();
  await page.getByRole("button", { name: /^Квитки/ }).click();
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

  // Після переходу на результати розмова на місці, і її видно після оновлення вкладки
  // (вкладка «ШІ-помічник» теж запам'ятовується).
  await page.reload();
  await expect(page.getByRole("tab", { name: "ШІ-помічник" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(conversation).toContainText("Куди і коли ви хочете полетіти?");
  // Новий чат — знову «Що шукаємо?»; попередня розмова — в історії.
  await page.getByRole("button", { name: "Новий чат" }).click();
  await expect(page.getByText("Що шукаємо?")).toBeVisible();
  await page.getByRole("button", { name: "Історія (1)" }).click();
  await page.getByRole("button", { name: /^Лісабон/ }).click();
  await expect(conversation).toContainText("Куди і коли ви хочете полетіти?");
});

test("житло: пошук → наш вибір → фільтр → резюме відгуків", async ({ page }) => {
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");

  // Mock-провайдер житла: 18 варіантів, показуємо по 10.
  // Приховані «Показати ще» картки теж у DOM — рахуємо лише видимі.
  const cards = page.locator('[data-testid="stay-card"]:visible');
  await expect(cards).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "Лісабон" })).toBeVisible();
  await expect(page.getByTestId("stay-price").first()).toContainText("€");
  await expect(page.locator('[data-testid="stay-top-pick"][data-label="balanced"]')).toHaveCount(1);
  await page.getByRole("button", { name: /Показати ще 8/ }).click();
  await expect(cards).toHaveCount(18);

  // Фільтр — лише безкоштовне скасування; маршрут і дати не губляться.
  await page.getByRole("checkbox", { name: "Лише безкоштовне" }).check();
  await expect(page).toHaveURL(/cancel=1/);
  await expect(page).toHaveURL(/city=LIS/);
  await expect(cards.first()).toContainText("Безкоштовне скасування");

  // Резюме відгуків — лише на вимогу (mock-модель).
  await page.getByRole("button", { name: "Підсумувати відгуки" }).click();
  await expect(page.getByTestId("stay-analysis")).toContainText("Радимо:");
});

test("помічник «уся поїздка»: загальна сума й сторінка поїздки", async ({ page }) => {
  await page.goto("/stays");
  await page.waitForLoadState("networkidle");

  await page.getByRole("tab", { name: "ШІ-помічник" }).click();
  await page.getByRole("button", { name: /^Уся поїздка/ }).click();
  await page.getByLabel("Запитайте ШІ-помічника").fill("Поїздка з Варшави до Лісабона");
  await page.getByRole("button", { name: "Надіслати" }).click();

  // Загальну суму рахує код (plan_trip), модель лише переказує.
  const conversation = page.getByRole("list", { name: "Розмова з помічником" });
  await expect(conversation).toContainText("разом");
  await conversation.getByRole("link", { name: "Поїздка" }).click();
  await expect(page).toHaveURL(/\/trip\?from=WAW&to=LIS/);
  await expect(page.getByTestId("trip-card").first()).toBeVisible();

  // Розмова на місці й після переходу; новий чат «Квитки» — окремий, порожній.
  await expect(conversation).toContainText("Поїздка з Варшави до Лісабона");
  await page.getByRole("button", { name: "Новий чат" }).click();
  await page.getByRole("button", { name: /^Квитки/ }).click();
  await expect(conversation).not.toContainText("Поїздка з Варшави до Лісабона");
});

test("поїздка: загальна сума, три варіанти, бюджет, посилання на рейс і житло", async ({
  page,
}) => {
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");

  const picks = page.locator(
    'section[aria-labelledby="trip-picks-title"] [data-testid="trip-card"]',
  );
  await expect(picks.first()).toBeVisible();
  await expect(page.locator('[data-testid="trip-card"][data-label="best_value"]')).toHaveCount(1);
  await expect(picks.first().getByTestId("trip-total")).toContainText("€");
  await expect(picks.first().getByTestId("trip-breakdown")).toContainText("Житло");

  // Нереальний бюджет — чесно кажемо, на скільки найдешевша поїздка дорожча.
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&budget=10");
  await expect(page.getByText(/не вкладається жодна поїздка/)).toBeVisible();

  await page
    .locator('[data-testid="trip-card"]')
    .first()
    .getByRole("link", { name: /Житло/ })
    .click();
  await expect(page).toHaveURL(/\/stays\?city=LIS/);
  await expect(page.locator('[data-testid="stay-card"]:visible').first()).toBeVisible();
});

test("підписка на ціну: створення → сторінка керування → вимкнення", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05");
  await page.getByTestId("offer-card").first().waitFor();

  await page.getByRole("button", { name: "Стежити за ціною" }).click();
  await page.locator("label", { hasText: "Email" }).click();
  await page.getByPlaceholder("you@example.com").fill("e2e@example.com");
  await page.getByRole("button", { name: "Підписатися" }).click();
  await expect(page.getByText(/надіслали лист/)).toBeVisible();

  // Лист (mock) містить посилання на ту саму сторінку керування: підтверджуємо й вимикаємо.
  await page.getByRole("link", { name: "Керувати підпискою" }).click();
  await expect(page.getByText("Чекає підтвердження")).toBeVisible();
  await page.getByRole("button", { name: "Підтвердити підписку" }).click();
  await expect(page.getByText("Підписку підтверджено")).toBeVisible();
  await expect(page.getByText("Активна")).toBeVisible();
  await page.getByRole("button", { name: "Вимкнути підписку" }).click();
  await expect(page.getByText("Вимкнена")).toBeVisible();

  // Повернення до результатів — позначка «стежите» (цей браузер памʼятає підписку).
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05");
  await expect(page.getByRole("link", { name: /Ви стежите за цим маршрутом/ })).toBeVisible();
});
