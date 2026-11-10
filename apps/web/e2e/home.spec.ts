import { expect, test } from "@playwright/test";

// API у e2e працює з mock-провайдером (див. playwright.config.ts): дані детерміновані,
// тож перевіряємо конкретні результати, а не «будь-що».

test("головна українською з формою пошуку і станом сервісів", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Подорож без зайвих вкладок: квитки, житло й план в одному місці",
  );
  // Три головні можливості (12.3) і режими пошуку (12.2).
  await expect(
    page.getByRole("list", { name: "Що вміє SkyPack" }).getByRole("listitem"),
  ).toHaveCount(3);
  await expect(page.getByTestId("search-modes").getByRole("link")).toHaveCount(3);
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
  // Свіжість ціни від API (модуль 17.3): mock — живе джерело, ціна щойно.
  await expect(page.getByTestId("price-freshness").first()).toHaveAttribute(
    "data-freshness",
    "live",
  );
  await expect(page.getByRole("heading", { name: "Наш вибір" })).toBeVisible();
  await expect(page.locator('[data-testid="top-pick"][data-label="balanced"]')).toHaveCount(1);
  await expect(page.getByTestId("airlines").first()).toContainText("LOT Polish");

  // «Чому цей варіант?» у будь-якій картці: конкретні причини й розбивка оцінки (модуль 14.5).
  await cards.first().getByText("Чому цей варіант?").click();
  await expect(cards.first().getByTestId("why-reasons")).toBeVisible();
  await expect(cards.first().getByTestId("breakdown")).toBeVisible();

  // Фільтр застосовується одразу і не губить маршрут.
  await page.getByRole("radio", { name: "Лише прямі" }).check();
  await expect(page).toHaveURL(/stops=0/);
  await expect(page).toHaveURL(/from=WAW/);
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 варіант з 4")).toBeVisible();
  // Обов'язкова вимога: відсіяне не ранжується, але видно, скільки й чому (модуль 14.1).
  await expect(page.getByTestId("excluded-note")).toContainText("3 — забагато пересадок");
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
  await page.getByRole("button", { name: "ШІ-пошук" }).click();
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

  // Після оновлення помічник згорнутий (модуль 23a: не заважає результатам) — кнопка
  // «ШІ-помічник» повертає його з тією самою розмовою.
  await page.reload();
  await expect(page.getByTestId("search-panel-chat")).toBeHidden();
  await page.getByTestId("chat-launcher").click();
  await expect(page.getByRole("button", { name: "ШІ-пошук" })).toHaveAttribute(
    "aria-pressed",
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

  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await page.getByRole("button", { name: /^Уся поїздка/ }).click();
  await page.getByLabel("Запитайте ШІ-помічника").fill("Поїздка з Варшави до Лісабона");
  await page.getByRole("button", { name: "Надіслати" }).click();

  // Загальну суму рахує код (plan_trip), модель лише переказує.
  const conversation = page.getByRole("list", { name: "Розмова з помічником" });
  await expect(conversation).toContainText("разом");
  await conversation.getByRole("link", { name: "Поїздка" }).click();
  await expect(page).toHaveURL(/\/trip\?from=WAW&to=LIS/);
  await expect(page.getByTestId("trip-card").first()).toBeVisible();

  // На сторінці поїздки помічник згорнутий (модуль 23a), кнопка повертає ту саму розмову;
  // новий чат «Квитки» — окремий, порожній.
  // (попередня сторінка лишається змонтованою прихованою — рахуємо лише видиме).
  await expect(page.locator('[data-testid="search-panel-chat"]:visible')).toHaveCount(0);
  await page.locator('[data-testid="chat-launcher"]:visible').click();
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
    .getByRole("link", { name: "Відкрити житло" })
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

test("сповіщення 11a: гнучкі дати, лише вихідні, зниження на відсоток; житло — неактивне", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-01&flex=range&until=2026-12-31&nmin=2&nmax=3");
  await page.getByTestId("offer-card").first().waitFor();
  await page.getByRole("button", { name: "Стежити за ціною" }).click();
  await expect(
    page.getByText(/Гнучкі дати: виліт 2026-12-01 – 2026-12-31, 2–3 ноч\./),
  ).toBeVisible();
  await page.getByLabel(/Лише вихідні/).check();
  // У формі пошуку теж є радіо «Ціна» (пріоритет) — лише в панелі підписки: третя умова.
  const alert = page.getByRole("region", { name: /Стежити за ціною/ });
  await alert.getByRole("radio", { name: /Ціна/ }).nth(2).check();
  await page.locator("label", { hasText: "Email" }).click();
  await page.getByPlaceholder("you@example.com").fill("e2e-flex@example.com");
  await page.getByRole("button", { name: "Підписатися" }).click();
  await expect(page.getByText(/надіслали лист/)).toBeVisible();

  await page.getByRole("link", { name: "Керувати підпискою" }).click();
  await expect(page.getByText(/виліт 1 грудня – 31 грудня, 2–3 ноч\./)).toBeVisible();
  await expect(page.getByText(/лише вихідні/)).toBeVisible();
  await expect(page.getByText("Ціна впаде щонайменше на 10%")).toBeVisible();

  // 11b: підтвердити, призупинити, відновити, змінити умову, історія, видалити.
  await page.getByRole("button", { name: "Підтвердити підписку" }).click();
  await expect(page.getByText("Активна", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Призупинити" }).click();
  await expect(page.getByText("Призупинена", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Відновити" }).click();
  await expect(page.getByText("Підписку відновлено.")).toBeVisible();
  const edit = page.getByTestId("alert-edit");
  await edit.getByText("Редагувати").click();
  await edit.getByRole("radio", { name: /Ціна до/ }).check();
  await edit.getByLabel("Поріг ціни, EUR").fill("150");
  await edit.getByRole("button", { name: "Зберегти зміни" }).click();
  await expect(page.getByText("Зміни збережено.")).toBeVisible();
  await expect(page.getByText(/ціна до 150/)).toBeVisible();
  const history = page.getByTestId("alert-history");
  await history.locator("summary").click();
  await expect(history).toContainText("Змінено");
  await expect(history).toContainText("Призупинено");
  await page.getByRole("button", { name: "Видалити" }).click();
  await expect(page.getByRole("heading", { name: "Підписку видалено" })).toBeVisible();

  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  await page.getByTestId("stay-card").first().waitFor();
  await expect(page.getByTestId("alert-unavailable")).toContainText("реальне джерело цін на житло");
});

test("режими пошуку (12.2): місто, дати й люди переходять між авіаквитками, житлом і поїздкою", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2");
  await page.getByTestId("offer-card").first().waitFor();
  const modes = page.getByTestId("search-modes");
  await expect(modes.getByRole("link", { name: "Авіаквитки" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await modes.getByRole("link", { name: "Житло" }).click();
  await expect(page).toHaveURL(/\/stays\?city=LIS&in=2026-12-05&out=2026-12-08&adults=2/);
  await page.getByTestId("stay-card").first().waitFor();

  await page.getByTestId("search-modes").getByRole("link", { name: "Поїздка" }).click();
  await expect(page).toHaveURL(/\/trip\?to=LIS&depart=2026-12-05&return=2026-12-08&adults=2/);
  await expect(page.locator("#trip-depart")).toHaveValue("2026-12-05");
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
  // «Огляд» (модуль 10a): привітання й швидкі дії.
  await expect(page.getByRole("heading", { name: "Вітаємо, Олена!" })).toBeVisible();
  await expect(page.getByTestId("quick-actions")).toContainText("Спланувати поїздку");
  await expect(page.getByRole("link", { name: "Особистий кабінет" })).toContainText("Олена");

  await page
    .getByRole("navigation", { name: "Розділи кабінету" })
    .getByRole("link", { name: "Налаштування" })
    .click();
  await expect(page.getByRole("heading", { name: "Профіль" })).toBeVisible();
  const profile = page.locator("#profile");
  await profile.getByLabel("Прізвище").fill("Тестова");
  await profile.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(profile.getByText("Збережено.")).toBeVisible();
  // Без фото — ініціали з імені й прізвища (модуль 10b).
  await expect(profile.getByTestId("user-avatar")).toHaveText("ОТ");

  // Налаштування пошуку (10b): тип житла → позначка з фільтром у новому пошуку житла.
  const prefs = page.getByTestId("search-prefs-form");
  await prefs.getByText("Готель", { exact: true }).click();
  await prefs.getByRole("button", { name: "Зберегти налаштування" }).click();
  await expect(prefs.getByText("Збережено.")).toBeVisible();
  await page.goto("/stays");
  await expect(page.getByTestId("stay-prefs-toggle")).toContainText("1 фільтр");

  // Пошук житла (mock) потрапляє в історію; «Зберегти пошук» — у збережене.
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  await page.getByTestId("stay-card").first().waitFor();
  await page.getByRole("button", { name: "Зберегти пошук" }).click();
  await expect(page.getByRole("link", { name: "У збереженому" })).toBeVisible();

  // Обраний квиток (модуль 10a) — в акаунті, у категорії «Квитки» й «Обраних маршрутах».
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-10");
  await page.getByTestId("favorite-toggle").first().click();
  await expect(page.getByTestId("favorite-toggle").first()).toHaveAttribute("aria-pressed", "true");
  await page.goto("/account/favorites");
  await page.getByTestId("favorites-tab-flight").click();
  await expect(page.getByTestId("favorite-item")).toContainText("WAW → LIS");
  await page.goto("/account");
  await expect(page.locator("#routes")).toContainText("WAW → LIS");

  await page.goto("/account/history");
  const saved = page.locator("#saved");
  const history = page.locator("#history");
  await expect(saved).toContainText("Лісабон");
  await expect(history).toContainText("Лісабон");
  // Параметри запису історії (10.5) без повторного пошуку.
  await history.getByTestId("entry-params").first().getByText("Параметри").click();
  await expect(history.getByTestId("entry-params").first()).toContainText("LIS");
  await saved.getByRole("link", { name: /Лісабон/ }).click();
  await expect(page).toHaveURL(/\/stays\?city=LIS/);

  // Мова (10b): англійська з перемикача — і назад; вибір запамʼятовує профіль.
  await page.getByRole("banner").getByTestId("language-switcher").selectOption("en");
  await expect(page.getByRole("link", { name: "My account" })).toBeVisible();
  await page.getByRole("banner").getByTestId("language-switcher").selectOption("uk");
  await expect(page.getByRole("link", { name: "Особистий кабінет" })).toBeVisible();

  // Вихід і вхід тим самим логіном.
  await page.goto("/account");
  await page.getByRole("button", { name: "Вийти", exact: true }).click();
  await expect(page.getByRole("link", { name: "Увійти" })).toBeVisible();
  await page.goto("/login");
  await page.getByLabel("Логін або email").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page).toHaveURL(/\/account/);

  // Налаштування сповіщень (10c) зберігаються в акаунті.
  await page.goto("/account/alerts");
  const notify = page.getByTestId("notify-form");
  await notify.getByLabel("Email", { exact: true }).uncheck();
  await notify.getByLabel("Частота").selectOption("72");
  await notify.getByRole("button", { name: "Зберегти" }).click();
  await expect(notify.getByText("Збережено.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId("notify-form").getByLabel("Email", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByTestId("notify-form").getByLabel("Частота")).toHaveValue("72");

  // Сесії (10c): поточна позначена, пристрій — з User-Agent браузера.
  await page.goto("/account/security");
  await expect(page.getByTestId("sessions")).toContainText("Ця сесія");
  await expect(page.getByTestId("sessions")).toContainText("Chrome");
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
  // Вибір до гідратації React не обробить (повільний CI) — повторюємо, доки не подіє.
  await expect(async () => {
    await page.getByLabel("Гнучкість дат").selectOption("month");
    await expect(page.getByLabel("Повернення")).toBeDisabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
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

  // «Чому цей варіант?» — причини з цифрами й розбивка оцінки (модуль 14.5).
  await card.getByText("Чому цей варіант?").click();
  await expect(card.getByTestId("stay-why-reasons")).toBeVisible();
  await expect(card.getByTestId("stay-breakdown")).toBeVisible();

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
  // Поки сторінка стрімиться, поруч є ще й запасна форма (Suspense) — чекаємо справжню.
  const more = page.getByText("Гнучкі дати, побажання й власні витрати");
  await expect(more).toHaveCount(1, { timeout: 15_000 });
  await more.click();
  await page.getByLabel("Ночей від").selectOption("3");
  await page.getByLabel("до", { exact: true }).selectOption("4");
  await page.getByLabel("Багаж").selectOption("carry_on");
  await page.getByLabel("Рейтинг від").selectOption("8");
  await page.getByLabel("Назва").first().fill("Музей");
  await page.getByLabel("Сума, EUR").first().fill("40");
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
  // Модуль 14.4–14.5: повноцінні ночі, час у дорозі й «Чому цей варіант?».
  await expect(picks.first().getByTestId("trip-quality")).toContainText("ночей повноцінні");
  await picks.first().getByText("Чому цей варіант?").click();
  await expect(picks.first().getByTestId("trip-why-reasons")).toBeVisible();
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
  // Поїздка → сповіщення (модуль 15): підписка на сторінці поїздки, тим самим блоком.
  await expect(trips.first().getByTestId("saved-trip-watch")).toHaveAttribute(
    "href",
    /^\/trip\?.*#price-alert$/,
  );
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

test("ШІ 9a: команди готової поїздки змінюють сторінку, зберігають і порівнюють", async ({
  page,
}) => {
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  await page.getByTestId("trip-choose").first().click();
  await expect(page.getByTestId("trip-builder")).toBeVisible({ timeout: 15_000 });
  const before = new URL(page.url()).searchParams;

  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await page.getByRole("button", { name: /^Уся поїздка/ }).click();
  const ask = async (text: string) => {
    await page.getByLabel("Запитайте ШІ-помічника").fill(text);
    await page.getByRole("button", { name: "Надіслати" }).click();
  };
  const conversation = page.getByRole("list", { name: "Розмова з помічником" });

  await ask("Знайди дешевший готель, авіаквитки не змінюй");
  await expect(conversation).toContainText(/Готово: тепер разом|Кращого варіанта/);
  const after = new URL(page.url()).searchParams;
  expect(after.get("flight")).toBe(before.get("flight")); // рейс не змінився

  await ask("Збережи цей варіант");
  await expect(conversation).toContainText("Зберіг поїздку");
  await ask("Порівняй з попереднім");
  await expect(conversation).toContainText("Порівняння додано");
  await expect(page.getByTestId("trip-compare-bar")).toContainText("Обрано поїздок: 2");

  await page.goto("/trips");
  await expect(page.getByTestId("saved-trip")).toHaveCount(1);
});

test("ШІ 9b: картки поїздок у чаті → планувальник; планувальник → «Оптимізувати з ШІ»", async ({
  page,
}) => {
  await page.goto("/stays");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await page.getByRole("button", { name: /^Уся поїздка/ }).click();
  await page.getByLabel("Запитайте ШІ-помічника").fill("Поїздка з Варшави до Лісабона");
  await page.getByRole("button", { name: "Надіслати" }).click();

  const card = page.getByTestId("chat-card-trip").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("€");
  await expect(card.getByTestId("chat-card-age")).toBeVisible();
  const total = await card.getByTestId("chat-card-total").innerText();
  await card.getByRole("link", { name: /Відкрити в планувальнику/ }).click();

  // Саме ця комбінація: рейс і житло закріплені, сума та сама.
  await expect(page).toHaveURL(/\/trip\?.*flight=.*stay=|\/trip\?.*stay=.*flight=/);
  const builder = page.getByTestId("trip-builder");
  await expect(builder).toBeVisible();
  await expect(builder.getByTestId("trip-total")).toHaveText(total);

  await builder.getByTestId("trip-optimize-ai").click();
  // Попередня сторінка (/stays) лишається змонтованою прихованою — дивимось лише видиме.
  await expect(page.getByText("Розмова: Уся поїздка").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByLabel("Запитайте ШІ-помічника").filter({ visible: true })).toHaveValue(
    /Оптимізуй цю поїздку/,
  );
});

test("ШІ 9c: історія чатів — перейменувати, продовжити, новий чат, видалити", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await page.getByRole("button", { name: /^Квитки/ }).click();
  await page.getByLabel("Запитайте ШІ-помічника").fill("Привіт");
  await page.getByRole("button", { name: "Надіслати" }).click();
  const conversation = page.getByRole("list", { name: "Розмова з помічником" });
  await expect(conversation).toContainText("Куди і коли");

  await page.getByRole("button", { name: "Новий чат" }).click();
  await page.getByRole("button", { name: /Історія/ }).click();
  await page.getByRole("button", { name: "Перейменувати розмову «Привіт»" }).click();
  await page.getByLabel("Назва розмови").fill("Мій перший чат");
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByText("Мій перший чат")).toBeVisible();
  await expect(page.getByText(/Увійдіть, щоб синхронізувати/)).toBeVisible();

  // Продовжити попередню розмову.
  await page.getByText("Мій перший чат").click();
  await expect(conversation).toContainText("Привіт");
  await page.getByRole("button", { name: /Історія/ }).click();
  await page.getByRole("button", { name: "Видалити розмову «Мій перший чат»" }).click();
  await expect(page.getByText("Мій перший чат")).toHaveCount(0);
});

test("модуль 15: рейс → «Додати до поїздки» → планувальник з цим рейсом і житлом на його дати", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2");
  const card = page.getByTestId("offer-card").first();
  await card.waitFor();
  await card.getByTestId("offer-add-to-trip").click();

  await expect(page).toHaveURL(/\/trip\?.*flight=/);
  await expect(page).toHaveURL(/adults=2/);
  await expect(page.getByTestId("trip-builder")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("trip-builder-notice")).toHaveCount(0);
});

test("модуль 18.2: житло в обраній валюті, вибір валюти переживає новий пошук", async ({
  page,
}) => {
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08&cur=PLN");
  await page.getByTestId("stay-card").first().waitFor();
  await expect(page.getByTestId("stay-price").first()).toContainText("zł");
  await expect(page.getByLabel("Валюта")).toHaveValue("PLN");
});

test("модуль 19: анонімна подія при відкритті деталей рейсу; без ідентифікаторів", async ({
  page,
}) => {
  // Тіло sendBeacon Chromium не показує тестам — перевіряємо запасний шлях (fetch keepalive).
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "sendBeacon", { value: undefined });
  });
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12");
  const card = page.getByTestId("offer-card").first();
  await card.waitFor();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.method() === "POST");
  await card.getByText("Деталі маршруту").click();
  const event = JSON.parse((await sent).postData() ?? "{}");
  expect(event).toEqual({ name: "offer_opened", props: { kind: "flight" } });
});

test("модуль 20.1/20.3: «Поділитися» — лише параметри пошуку; останні пошуки на головній", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2&stops=0");
  await page.getByTestId("offer-card").first().waitFor();
  const share = page.getByTestId("search-share");
  await expect(share).toHaveAttribute(
    "data-share-href",
    "/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2&stops=0",
  );

  await page.goto("/");
  const recent = page.getByTestId("recent-search").first();
  await expect(recent).toContainText("WAW → LIS");
  await recent.click();
  await expect(page).toHaveURL(/from=WAW&to=LIS/);
  await expect(page.getByTestId("offer-card").first()).toBeVisible();
});

test("модуль 20.2: публічне посилання на поїздку — вимкнене за замовчуванням, без особистого", async ({
  page,
}) => {
  const username = `share_${Date.now()}`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Логін", { exact: true }).fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.getByLabel("Пароль ще раз").fill("password123");
  await page.getByRole("button", { name: "Зареєструватися" }).click();
  await expect(page).toHaveURL(/\/account/);

  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  const picks = page.locator(
    'section[aria-labelledby="trip-picks-title"] [data-testid="trip-card"]',
  );
  await expect(picks.first()).toBeVisible({ timeout: 15_000 });
  await picks.first().getByTestId("trip-choose").click();
  await page.getByTestId("trip-save").click();
  await expect(page.getByTestId("trip-save")).toContainText("Збережено");

  await page.goto("/account/trips");
  await expect(page.getByTestId("trip-public-share")).toHaveCount(0); // приватна за замовчуванням
  await page.getByTestId("trip-public-on").click();
  const link = page.getByTestId("trip-public-share");
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("data-share-href"))!;
  expect(href).toMatch(/^\/shared\/trip\/[A-Za-z0-9_-]{20,}$/);

  await page.goto(href);
  const shared = page.getByTestId("shared-trip");
  await expect(shared).toContainText("WAW → LIS");
  await expect(page.getByTestId("shared-trip-total")).toContainText("€");
  await expect(page.locator("main")).not.toContainText(username);
  await expect(page.getByTestId("shared-trip-open")).toHaveAttribute("href", /^\/trip\?/);

  await page.goto("/account/trips");
  await page.getByTestId("trip-public-off").click();
  await expect(page.getByTestId("trip-public-on")).toBeVisible();
  await page.goto(href);
  await expect(page.getByTestId("shared-trip-missing")).toBeVisible();

  await page.goto("/account/security");
  await page.getByLabel("Пароль для підтвердження").fill("password123");
  await page.getByRole("button", { name: "Видалити акаунт" }).click();
});

test("модуль 20.4: введене у форму переживає оновлення сторінки, але пошук сам не запускається", async ({
  page,
}) => {
  await page.goto("/");
  // Підказки й чернетка працюють після гідратації (приховане поле з кодом з'являється тоді ж).
  await page.locator('input[type="hidden"][name="to"]').waitFor({ state: "attached" });
  await page.getByLabel("Куди").fill("lis");
  await page
    .getByRole("option", { name: /Лісабон/ })
    .first()
    .click();
  await page.getByLabel("Виліт").fill("2026-12-05");
  await expect(page).toHaveURL(/to=LIS.*depart=2026-12-05.*draft=1/);

  await page.reload();
  await expect(page.getByLabel("Виліт")).toHaveValue("2026-12-05");
  await expect(page.getByLabel("Куди")).toHaveValue(/Лісабон/);
  await expect(page.getByTestId("offer-card")).toHaveCount(0); // шукає лише кнопка
});

test("модуль 20.5: порожні результати — альтернативи, кожна з однією зміною", async ({ page }) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&stops=0&maxp=1");
  const help = page.getByTestId("empty-suggestions");
  await expect(help).toBeVisible();
  await expect(page.getByTestId("offer-card")).toHaveCount(0);
  await expect(help.locator('[data-suggestion="higherBudget"]')).toContainText("2 €");

  await help.locator('[data-suggestion="allowStops"]').click();
  await expect(page).not.toHaveURL(/stops=0/);
  await expect(page).toHaveURL(/maxp=1/); // інші умови — без змін
});

test("модуль 21.6: обрив мережі — помилка з повтором, а не вічне завантаження", async ({
  page,
}) => {
  await page.goto("/stays?city=LIS&in=2026-12-05&out=2026-12-08");
  const card = page
    .getByTestId("stay-card")
    .filter({ has: page.getByTestId("stay-rates-toggle") })
    .first();
  await card.waitFor();

  await page.route("**/api/stays/rates", (route) => route.abort("internetdisconnected"));
  await card.getByTestId("stay-rates-toggle").click();
  const notice = card.getByTestId("retry-notice");
  await expect(notice).toBeVisible();

  // Мережа повернулась — «Спробувати ще раз» працює.
  await page.unroute("**/api/stays/rates");
  await notice.getByRole("button", { name: "Спробувати ще раз" }).click();
  await expect(card.getByTestId("stay-rates")).toBeVisible();
  await expect(card.getByTestId("retry-notice")).toHaveCount(0);
});

test("модуль 21.1: сортування — «Швидші» впорядковує картки за часом у дорозі", async ({
  page,
}) => {
  await page.goto("/?from=WAW&to=LIS&depart=2026-12-05&sort=duration");
  const cards = page.getByTestId("offer-card");
  await cards.first().waitFor();
  const minutes = await page.getByTestId("total-duration").evaluateAll((nodes) =>
    nodes.map((n) => {
      const m = /(\d+)\s*год(?:\s*(\d+))?/.exec(n.textContent ?? "");
      return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : Number.POSITIVE_INFINITY;
    }),
  );
  expect(minutes.length).toBeGreaterThan(1);
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
});

test("модуль 23b: обрана поїздка не губиться між розділами, помічник не розкривається сам", async ({
  page,
}) => {
  test.slow(); // три розділи з пошуками й поверненнями
  await page.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  await page.waitForLoadState("networkidle");

  // Обрати варіант — сторінка відкривається на «Вашій поїздці».
  await page.getByTestId("trip-choose").first().click();
  await expect(page).toHaveURL(/flight=.*#your-trip$/);
  const builder = page.getByTestId("trip-builder");
  await expect(builder).toBeInViewport();
  const chosen = new URL(page.url()).searchParams;

  // Помічник відкрили тут, потім перейшли в «Авіаквитки» — там він згорнутий.
  await page.locator('[data-testid="chat-launcher"]:visible').click();
  await expect(page.locator('[data-testid="search-panel-chat"]:visible')).toHaveCount(1);
  await page
    .locator('[data-testid="search-modes"]:visible')
    .getByRole("link", { name: "Авіаквитки" })
    .click();
  await expect(page).toHaveURL(/^[^?]*\/\?from=WAW&to=LIS/);
  await expect(page.locator('[data-testid="search-panel-chat"]:visible')).toHaveCount(0);

  // Назад у «Поїздку» (перемикач і шапка) — та сама поїздка з вибором рейсу й житла.
  await page
    .locator('[data-testid="search-modes"]:visible')
    .getByRole("link", { name: "Поїздка" })
    .click();
  await expect(page).toHaveURL(/\/trip\?/);
  const back = new URL(page.url()).searchParams;
  expect([back.get("flight"), back.get("stay")]).toEqual([
    chosen.get("flight"),
    chosen.get("stay"),
  ]);
  await expect(page.locator('[data-testid="trip-builder"]:visible')).toHaveCount(1);
  await expect(page.locator('[data-testid="search-panel-chat"]:visible')).toHaveCount(0);

  const sections = page.locator('nav[aria-label="Розділи сайту"]:visible');
  await sections.getByRole("link", { name: "Перельоти" }).click();
  await expect(page).toHaveURL(/from=WAW&to=LIS/);
  await expect(page.locator('[data-testid="offer-card"]:visible').first()).toBeVisible();
  await sections.getByRole("link", { name: "Поїздка" }).click();
  await expect(page).toHaveURL(new RegExp(`flight=${encodeURIComponent(chosen.get("flight")!)}`));
});
