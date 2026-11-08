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
  await page.getByRole("link", { name: "Скинути всі" }).click();
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

  // Mock-провайдер житла: 19 варіантів, показуємо по 10.
  // Приховані «Показати ще» картки теж у DOM — рахуємо лише видимі.
  const cards = page.locator('[data-testid="stay-card"]:visible');
  await expect(cards).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "Лісабон" })).toBeVisible();
  await expect(page.getByTestId("stay-price").first()).toContainText("€");
  await expect(page.locator('[data-testid="stay-top-pick"][data-label="balanced"]')).toHaveCount(1);
  await page.getByRole("button", { name: /Показати ще 9/ }).click();
  await expect(cards).toHaveCount(19);

  // Фільтр — лише безкоштовне скасування; маршрут і дати не губляться.
  await page.getByRole("checkbox", { name: "Безкоштовне скасування" }).check();
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

test("кабінет: реєстрація → профіль → історія й збережене → вихід і вхід → видалення", async ({
  page,
}) => {
  const username = `e2e_${Date.now()}`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Логін", { exact: true }).fill(username);
  await page.getByLabel("Ім'я").fill("Олена");
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByLabel("Пароль ще раз").fill("password123");
  await page.getByRole("button", { name: "Зареєструватися" }).click();

  await expect(page).toHaveURL(/\/account/);
  await expect(page.getByRole("heading", { name: "Профіль" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Особистий кабінет" })).toContainText("Олена");

  await page.getByLabel("Прізвище").fill("Тестова");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(page.getByText("Збережено.")).toBeVisible();

  // Пошук житла (mock) потрапляє в історію; «Зберегти пошук» — у збережене.
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  await page.getByTestId("stay-card").first().waitFor();
  await page.getByRole("button", { name: "Зберегти пошук" }).click();
  await expect(page.getByRole("link", { name: "У збереженому" })).toBeVisible();

  await page.goto("/account");
  const saved = page.locator("#saved");
  const history = page.locator("#history");
  await expect(saved).toContainText("Лісабон");
  await expect(history).toContainText("Лісабон");
  await saved.getByRole("link", { name: /Лісабон/ }).click();
  await expect(page).toHaveURL(/\/stays\?city=LIS/);

  // Вихід і вхід тим самим логіном.
  await page.goto("/account");
  await page.getByRole("button", { name: "Вийти", exact: true }).click();
  await expect(page.getByRole("link", { name: "Увійти" })).toBeVisible();
  await page.goto("/login");
  await page.getByLabel("Логін або email").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page).toHaveURL(/\/account/);

  await page.getByLabel("Пароль для підтвердження").fill("password123");
  await page.getByRole("button", { name: "Видалити акаунт" }).click();
  await expect(page).toHaveURL(/\/\?done=deleted|\/$/);
  await page.goto("/login");
  await page.getByLabel("Логін або email").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page.getByText("Невірний логін або пароль.")).toBeVisible();
});

test("сім'я з багажем: ціна за всіх, умови багажу, найдешевший — з багажем", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&adults=2&children=1&lap=1&bag=checked");

  await expect(page.getByTestId("offer-card").first()).toBeVisible();
  // Ціна — за весь склад, а не «за 1 дорослого» (ADR 0013).
  await expect(page.getByText("разом за 4 пасажирів").first()).toBeVisible();
  // У mock умови багажу відомі: кожна картка показує розбивку й ціну з валізою.
  await expect(page.getByTestId("baggage").first()).toContainText("Зареєстрований");
  await expect(page.getByTestId("baggage-total").first()).toContainText(/З багажем|у тарифі/);
  await expect(page.getByTestId("cheapest-basis")).toBeVisible();
  await page.screenshot({ path: "test-results/family-baggage.png", fullPage: true });
});

test("розширені фільтри: час туди й назад, пересадки, бюджет — з URL і без нових запитів", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12");
  const all = await page.getByTestId("offer-card").count();
  expect(all).toBeGreaterThan(1);

  await page.goto(
    "/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&dep=morning,afternoon&rdeph=12-23&maxlay=6&maxt=900",
  );

  await expect(page.getByRole("group", { name: "Виліт назад" })).toBeVisible();
  await expect(page.getByLabel("Виліт назад: з години")).toHaveValue("12");
  await expect(page.getByLabel("Одна пересадка, не довше")).toHaveValue("6");
  const filtered = await page.getByTestId("offer-card").count();
  expect(filtered).toBeLessThanOrEqual(all);
  await page.screenshot({ path: "test-results/filters.png", fullPage: true });

  // Розширені фільтри розгорнуті, бо серед них є активні; лічильник — усі активні.
  await expect(page.getByTestId("filters-count")).toHaveText("4");
  // «Зберегти налаштування» (гість — у браузері) → новий пошук пропонує їх застосувати.
  await page.getByRole("button", { name: "Зберегти налаштування" }).click();
  await expect(page.getByText(/Збережено в цьому браузері/)).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("checkbox", { name: "Застосувати збережені фільтри (4)" }),
  ).toBeChecked();
});

test("гнучкі дати: альтернативні дати й перехід на точні", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&flex=3");

  await expect(page.getByRole("heading", { name: "Альтернативні дати" })).toBeVisible();
  const options = page.getByTestId("date-option");
  expect(await options.count()).toBeGreaterThan(1);
  await expect(page.getByLabel("Гнучкість дат")).toHaveValue("3");

  await options.first().click();
  await expect(page).not.toHaveURL(/flex=/);
  await expect(page.getByTestId("offer-card").first()).toBeVisible();
});

test("3–5 ночей у грудні: форма без дати повернення, ночі в альтернативних датах", async ({
  page,
}) => {
  // Туди й назад (є повернення) — тоді для місяця з'являються поля ночей.
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  await page.getByLabel("Гнучкість дат").selectOption("month");
  await expect(page.getByLabel("Повернення")).toBeDisabled();
  await page.getByLabel("Ночей від").selectOption("3");
  await page.getByLabel("Ночей до").selectOption("5");
  await page.getByRole("button", { name: "Шукати" }).click();

  await expect(page).toHaveURL(/flex=month/);
  await expect(page).toHaveURL(/nmin=3&nmax=5/);
  await expect(page.getByRole("heading", { name: "Альтернативні дати" })).toBeVisible();
  // Кожна пара дат — у межах 3–5 ночей.
  for (const text of await page.getByTestId("nights").allTextContents()) {
    expect(text).toMatch(/^[345] ноч/);
  }
});

test("матриця туди-назад і календар: гортання місяців, вибір дати без форми", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12");

  await expect(page.getByRole("heading", { name: "Матриця цін туди й назад" })).toBeVisible();
  const cells = page.getByTestId("matrix-cell");
  expect(await cells.count()).toBeGreaterThan(5);
  await page.screenshot({ path: "test-results/matrix.png", fullPage: true });

  await page.getByRole("link", { name: "Наступний місяць" }).click();
  await expect(page).toHaveURL(/cal=2027-01/);
  await expect(page.getByRole("heading", { name: /Календар цін — січень 2027/ })).toBeVisible();

  await cells.first().click();
  await expect(page).not.toHaveURL(/depart=2026-12-05&return=2026-12-12/);
  await expect(page.getByTestId("offer-card").first()).toBeVisible();
});

test("картка: позначки, деталі маршруту, порівняння трьох варіантів", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05");
  const cards = page.getByTestId("offer-card");
  await expect(cards.first()).toBeVisible();
  await expect(page.getByTestId("offer-badges").first()).toBeVisible();

  await cards.first().getByText("Деталі маршруту").click();
  await expect(cards.first().getByTestId("segment").first()).toBeVisible();
  await page.screenshot({ path: "test-results/card.png", fullPage: true });

  for (const i of [0, 1, 2]) await cards.nth(i).getByTestId("compare-toggle").click();
  await expect(cards.nth(3).getByTestId("compare-toggle")).toBeDisabled();
  await page.getByTestId("compare-bar").getByRole("button", { name: "Порівняти" }).click();
  const table = page.getByTestId("compare-table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(4);
  await table.getByRole("button", { name: "Прибрати з порівняння" }).first().click();
  await expect(page.getByTestId("compare-bar")).toContainText("2 з 3");
});

test("карта житла: режим «Карта», маркери з цінами, коротка картка, список поруч", async ({
  page,
}) => {
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  await page.getByRole("link", { name: "Карта" }).click();
  await expect(page).toHaveURL(/view=map/);

  const markers = page.getByTestId("stay-marker");
  await expect(markers.first()).toBeVisible({ timeout: 15_000 });
  expect(await markers.count()).toBe(19); // у mock координати є в усіх
  await markers.first().click();
  await expect(page.getByTestId("stay-map-card")).toContainText("€");

  // Широкий екран — компактний список поруч; «На карті» вибирає об'єкт.
  await page.getByTestId("stay-map-list").getByRole("button", { name: "На карті" }).nth(2).click();
  await expect(page.getByTestId("stay-map-card")).toBeVisible();
});

test("житло: детальніше, порівняння цін продавців, обране, додати до поїздки", async ({ page }) => {
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  const card = page
    .getByTestId("stay-card")
    .filter({ has: page.getByTestId("stay-sellers") })
    .first();
  await expect(card).toBeVisible();

  await card.getByTestId("stay-details-toggle").click();
  await expect(card.getByTestId("stay-details")).toContainText("До центру");

  await card.getByTestId("stay-rates-toggle").click();
  await expect(card.getByTestId("stay-rates")).toBeVisible();
  expect(await card.getByTestId("stay-room").count()).toBeGreaterThan(1);
  // Перший продавець базового номера — рівно ціна з картки.
  const total = await card.getByTestId("stay-total").innerText();
  const firstFinal = await card.getByTestId("stay-rate-final").first().innerText();
  expect(total).toContain(firstFinal.replace(/\s/g, " ").trim().split(" ")[0]);

  const name = await card.getByTestId("stay-name").innerText();
  await card.getByTestId("favorite-toggle").click();
  await expect(card.getByTestId("favorite-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("banner").getByRole("link", { name: "Обране" }).click();
  await expect(page.getByTestId("favorite-item")).toContainText(name);
  await expect(page.getByTestId("favorite-item")).toContainText("ціна на");
  await page.getByTestId("favorite-remove").click();
  await expect(page.getByTestId("favorites-empty")).toBeVisible();

  await page.goBack();
  const again = page.getByTestId("stay-card").filter({ hasText: name }).first();
  await again.getByTestId("stay-add-to-trip").click();
  await expect(page).toHaveURL(/\/trip\?.*stay=mock/);
  await expect(page.getByTestId("trip-pinned-stay")).toBeVisible();
  await expect(page.getByText("Вкажіть місто вильоту")).toBeVisible();
});

test("поїздка 8a: гнучкий період і тривалість, побажання, сценарії й бюджет за статусами", async ({
  page,
}) => {
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05");
  await page.getByText("Гнучкі дати, побажання й власні витрати").click();
  await page.getByLabel("Ночей від").selectOption("3");
  await page.getByLabel("до", { exact: true }).selectOption("4");
  await page.getByLabel("Багаж").selectOption("carry_on");
  await page.getByLabel("Рейтинг від").selectOption("8");
  await page.getByLabel("Назва").first().fill("Музей");
  await page.getByLabel("Сума, €").first().fill("40");
  await page.getByRole("button", { name: "Скласти поїздку" }).click();

  await expect(page).toHaveURL(/nmin=3&nmax=4/);
  const picks = page.locator(
    'section[aria-labelledby="trip-picks-title"] [data-testid="trip-card"]',
  );
  await expect(picks.first()).toBeVisible({ timeout: 15_000 });
  const labels = await picks.evaluateAll((cards) => cards.map((c) => c.getAttribute("data-label")));
  expect(new Set(labels).size).toBe(labels.length); // сценарії не дублюються
  const breakdown = picks.first().getByTestId("trip-breakdown");
  await expect(breakdown).toContainText("Квитки");
  await expect(breakdown).toContainText("Багаж");
  await expect(breakdown).toContainText("Музей");
  await expect(breakdown).toContainText("Орієнтовно");
  await expect(picks.first().getByTestId("trip-dates")).toContainText("→ заїзд");
  // Форма зберегла умови: розкрита, зі значеннями з URL.
  await expect(page.getByLabel("Рейтинг від")).toHaveValue("8");
});

test("поїздка 8b: обрати, замінити житло й рейс, повернути, знайти дешевше", async ({ page }) => {
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  await page.getByTestId("trip-choose").first().click();
  const builder = page.getByTestId("trip-builder");
  await expect(builder).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/flight=.*stay=|stay=.*flight=/);
  const chosen = new URL(page.url()).searchParams;

  // Замінити житло: рейс лишається, сума перераховується.
  await builder.getByTestId("trip-stay-options").locator("summary").click();
  await builder.getByTestId("trip-stay-options").getByTestId("trip-option").first().click();
  await expect(page).not.toHaveURL(new RegExp(`stay=${encodeURIComponent(chosen.get("stay")!)}`));
  expect(new URL(page.url()).searchParams.get("flight")).toBe(chosen.get("flight"));
  await expect(page.getByTestId("trip-builder")).toBeVisible();

  // Повернути попередній вибір.
  await page.getByTestId("trip-undo").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("stay")).toBe(chosen.get("stay"));

  // Замінити рейс: обране житло передаємо далі (сервер перевірить його на нові дати).
  await page.getByTestId("trip-flight-options").locator("summary").click();
  await page.getByTestId("trip-flight-options").getByTestId("trip-option").first().click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("flight"))
    .not.toBe(chosen.get("flight"));
  expect(new URL(page.url()).searchParams.get("stay")).toBe(chosen.get("stay"));

  // Знайти дешевший варіант: було/стало або чесне «не знайшлося».
  await page.getByTestId("trip-cheaper").click();
  const result = page.getByTestId("trip-cheaper-result");
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toContainText(/Перевірено/);
  const apply = page.getByTestId("trip-cheaper-apply");
  if (await apply.isVisible()) {
    await apply.click();
    await expect(page.getByTestId("trip-builder")).toBeVisible();
    await expect(page.getByTestId("trip-builder-notice")).toHaveCount(0);
  }
});

test("поїздка 8c: порівняння, зберегти, мої поїздки, оновити ціни, копія, редагувати, видалити", async ({
  page,
}) => {
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  const picks = page.locator(
    'section[aria-labelledby="trip-picks-title"] [data-testid="trip-card"]',
  );
  await expect(picks.first()).toBeVisible({ timeout: 15_000 });
  test.skip((await picks.count()) < 2, "mock дав один сценарій");
  await picks.nth(0).getByTestId("trip-compare-toggle").click();
  await picks.nth(1).getByTestId("trip-compare-toggle").click();
  await page.getByTestId("trip-compare-open").click();
  const table = page.getByTestId("trip-compare-table");
  await expect(table).toContainText("Загальний бюджет");
  await expect(table).toContainText("Тривалість подорожі");
  await page.keyboard.press("Escape");
  await page.getByTestId("trip-compare-bar").getByRole("button", { name: "Очистити" }).click();

  await picks.first().getByTestId("trip-choose").click();
  await expect(page.getByTestId("trip-builder")).toBeVisible();
  await page.getByTestId("trip-save").click();
  await expect(page.getByTestId("trip-save")).toContainText("Збережено");
  await page.getByRole("link", { name: "Мої поїздки" }).first().click();

  const trips = page.getByTestId("saved-trip");
  await expect(trips).toHaveCount(1);
  await expect(trips.first()).toContainText("сума на");
  await trips.first().getByTestId("saved-trip-refresh").click();
  await expect(page.getByTestId("saved-trip-refreshed")).toContainText("Зараз:");
  await trips.first().getByTestId("saved-trip-copy").click();
  await expect(trips).toHaveCount(2);

  // Редагувати: зміна житла лишається в режимі редагування, «Зберегти зміни» — без нової.
  await trips.first().getByTestId("saved-trip-open").click();
  await expect(page).toHaveURL(/saved=/);
  await expect(page.getByTestId("trip-save")).toContainText("Зберегти зміни");
  await page.getByTestId("trip-stay-options").locator("summary").click();
  await page.getByTestId("trip-stay-options").getByTestId("trip-option").first().click();
  await expect(page).toHaveURL(/saved=/);
  await expect(page.getByTestId("trip-save")).toContainText("Зберегти зміни");
  await page.getByTestId("trip-save").click();
  await expect(page.getByTestId("trip-save")).toContainText("Збережено");
  await page.goto("/trips");
  await expect(trips).toHaveCount(2);

  await trips.first().getByTestId("saved-trip-delete").click();
  await trips.first().getByTestId("saved-trip-delete-yes").click();
  await expect(trips).toHaveCount(1);
});
