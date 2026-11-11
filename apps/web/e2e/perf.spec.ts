import { type Browser, type Page, expect, test } from "@playwright/test";

/**
 * Швидкодія ключових сторінок (V3, етап 9): LCP, CLS, TBT (сума довгих задач понад 50 мс —
 * лабораторний відповідник INP), затримка взаємодії (Event Timing), обсяг JavaScript.
 * Продакшн-збірка й тестовий API з mock-джерелами (як e2e). Два профілі: комп'ютер і
 * «середній телефон» (CPU ×4, повільний 4G: 150 мс, 1,6 Мбіт/с).
 *
 *   PERF=1 npx playwright test perf          # друкує таблицю; без PERF — пропуск
 */
test.skip(!process.env.PERF, "лише на вимогу: PERF=1");
test.setTimeout(300_000);

const PAGES: [string, string][] = [
  ["головна", "/"],
  ["рейси", "/?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12"],
  ["житло", "/stays?city=LIS&in=2026-12-05&out=2026-12-08"],
  ["житло: карта", "/stays?city=LIS&in=2026-12-05&out=2026-12-08&view=map"],
  ["поїздка", "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08"],
  ["explore", "/explore?from=WAW"],
  ["explore: карта", "/explore?from=WAW&depart=2026-12-01&until=2026-12-31&nmin=2&nmax=4&view=map"],
];

type Metrics = { lcp: number; cls: number; tbt: number; inp: number | null; js: number };

const OBSERVE = () => {
  const w = window as unknown as Record<string, number>;
  w.__lcp = 0;
  w.__cls = 0;
  w.__tbt = 0;
  w.__inp = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__lcp = e.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
    })[])
      if (!e.hadRecentInput) w.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__tbt += Math.max(0, e.duration - 50);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { interactionId: number })[])
      if (e.interactionId) w.__inp = Math.max(w.__inp, e.duration);
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
};

async function measure(page: Page, path: string): Promise<Metrics> {
  await page.addInitScript(OBSERVE);
  await page.goto(path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  // Взаємодія: друк у першому текстовому полі (місто, дати — як людина).
  const field = page.locator('input[type="text"]:visible, input[role="combobox"]:visible').first();
  let inp: number | null = null;
  if (await field.count()) {
    await field.click();
    await field.pressSequentially("Лі", { delay: 80 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    inp = await page.evaluate(() => (window as unknown as Record<string, number>).__inp);
  }
  return page.evaluate((measuredInp) => {
    const w = window as unknown as Record<string, number>;
    const js = performance
      .getEntriesByType("resource")
      .filter((r) => (r as PerformanceResourceTiming).initiatorType === "script")
      .reduce((sum, r) => sum + (r as PerformanceResourceTiming).transferSize, 0);
    return { lcp: w.__lcp, cls: w.__cls, tbt: w.__tbt, inp: measuredInp, js };
  }, inp);
}

function row(name: string, m: Metrics): string {
  const inp = m.inp == null ? "—" : `${Math.round(m.inp)}`;
  return `| ${name} | ${Math.round(m.lcp)} | ${m.cls.toFixed(3)} | ${Math.round(m.tbt)} | ${inp} | ${Math.round(m.js / 1024)} |`;
}

const HEADER = [
  "| Сторінка | LCP, мс | CLS | TBT, мс | INP*, мс | JS, КБ |",
  "|---|---|---|---|---|---|",
];
const UK = {
  cookies: [
    {
      name: "NEXT_LOCALE",
      value: "uk",
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
};

/** Кожна сторінка — у новому контексті: холодний кеш (JS рахується), спостерігачі не накопичуються. */
async function profile(browser: Browser, mobile: boolean): Promise<[string, Metrics][]> {
  const out: [string, Metrics][] = [];
  for (const [name, path] of PAGES) {
    const context = await browser.newContext(
      mobile
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            storageState: UK,
          }
        : { viewport: { width: 1280, height: 900 }, storageState: UK },
    );
    const page = await context.newPage();
    if (mobile) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
    }
    out.push([name, await measure(page, path)]);
    await context.close();
  }
  return out;
}

for (const mobile of [false, true]) {
  test(`швидкодія: ${mobile ? "середній телефон (CPU ×4, повільний 4G)" : "комп'ютер"}`, async ({
    browser,
  }) => {
    const results = await profile(browser, mobile);
    console.log(
      [
        `\n### ${mobile ? "Середній телефон" : "Комп'ютер"}`,
        ...HEADER,
        ...results.map(([n, m]) => row(n, m)),
      ].join("\n"),
    );
    // Пороги — «добре» за Web Vitals (p75): LCP < 2,5 с, CLS < 0,1.
    for (const [name, m] of results) {
      expect.soft(m.lcp, `${name}: LCP`).toBeLessThan(2500);
      expect.soft(m.cls, `${name}: CLS`).toBeLessThan(0.1);
    }
  });
}

test("швидкодія: «Ваша поїздка», кабінет, ШІ-чат (середній телефон)", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    storageState: UK,
  });
  const throttle = async (page: Page) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  };
  const rows: string[] = [];

  // «Ваша поїздка»: адреса з обраними рейсом і житлом — з першої картки.
  const setup = await context.newPage();
  await setup.goto("/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08");
  const yourTrip = await setup.getByTestId("trip-choose").first().getAttribute("href");
  // Кабінет: новий акаунт (cookie сесії лишається в контексті).
  await setup.goto("/login?mode=register");
  await setup.getByLabel("Логін", { exact: true }).fill(`perf_${Date.now()}`);
  await setup.getByLabel("Пароль", { exact: true }).fill("password123");
  await setup.getByLabel("Пароль ще раз").fill("password123");
  await setup.getByRole("button", { name: "Зареєструватися" }).click();
  await setup.waitForURL(/\/account/);
  await setup.close();

  for (const [name, path] of [
    ["ваша поїздка", yourTrip ?? "/trip"],
    ["кабінет", "/account"],
    ["кабінет: поїздки", "/account/trips"],
  ] as const) {
    const page = await context.newPage();
    await throttle(page);
    rows.push(row(name, await measure(page, path)));
    await page.close();
  }

  // ШІ-чат: затримка відповіді інтерфейсу на клік «ШІ-пошук» (відкриття панелі).
  const page = await context.newPage();
  await throttle(page);
  await page.addInitScript(OBSERVE);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "ШІ-пошук" }).click();
  await page.getByText("Що шукаємо?").waitFor();
  await page.waitForTimeout(500);
  const inp = await page.evaluate(() => (window as unknown as Record<string, number>).__inp);
  rows.push(`| ШІ-чат: відкрити | — | — | — | ${Math.round(inp)} | — |`);
  await context.close();

  console.log(["\n### Інші сценарії (середній телефон)", ...HEADER, ...rows].join("\n"));
});
