import { expect, test } from "@playwright/test";

test("головна сторінка українською і показує стан сервісів", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Розумний пошук подорожей");
  await expect(page.getByText("Стан сервісів")).toBeVisible();
});
