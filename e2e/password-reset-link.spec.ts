import { test, expect } from "@playwright/test";

// A password-reset email is opened by someone who can't sign in. The link must
// reach the reset form with its token, not bounce to the sign-in page, which
// drops the token and leaves no way to reset.
test("a signed-out visit to the reset link shows the reset form", async ({ page }) => {
  await page.goto("/reset-password?token=not-a-real-token");

  await expect(page).toHaveURL(/\/reset-password\?token=not-a-real-token$/);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByPlaceholder("New password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set new password" })).toBeVisible();
});
