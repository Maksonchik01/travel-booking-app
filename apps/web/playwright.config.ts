import { defineConfig, devices } from "@playwright/test";

// Окремі порти: e2e не чіпає робочий `make up` (3000/8000) і не витрачає квоту
// живих джерел — API піднімається з mock-провайдером (детерміновані дані).
const PORT = Number(process.env.WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
const API_URL = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `uv run uvicorn tickets_api.asgi:app --port ${API_PORT}`,
      cwd: "../..",
      url: `${API_URL}/health`,
      // Змінні оточення мають пріоритет над .env: лише mock, без ключів і квот.
      env: {
        FLIGHT_PROVIDERS: "mock",
        CALENDAR_PROVIDERS: "mock",
        LLM_PROVIDER: "mock",
        STAY_PROVIDERS: "mock",
        ALERT_PROVIDERS: "mock",
        // Справжній бот і пошта з .env у e2e не потрібні: сповіщення — лише в лог.
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_BOT_USERNAME: "",
        SMTP_HOST: "",
        SENTRY_DSN: "",
        LOG_LEVEL: "WARNING",
      },
      reuseExistingServer: false,
    },
    {
      command: `npm run start -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      env: { API_URL },
      reuseExistingServer: false,
    },
  ],
});
