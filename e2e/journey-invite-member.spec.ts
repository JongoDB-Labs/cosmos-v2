import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — invite a member. An ADMIN opens the invite dialog from /team,
 * enters a unique email (role defaults to MEMBER), submits, and the dialog
 * confirms "Invitation sent". Exercises auth + the org-members RBAC gate + the
 * invitation create mutation.
 *
 * Self-contained. Mutating → runs in the gated CI e2e job; the non-mutating
 * selector path was validated locally. Email delivery is best-effort and does
 * NOT block (the seeded user has no Google token, so it no-ops server-side).
 * Asserts the in-dialog "Invitation sent" state (immediate, stable) rather than
 * the table's "Pending" row (which can lag under Cache Components). Unique email
 * per run avoids any duplicate-member 409.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — invite member", () => {
  test("invite a teammate: dialog confirms the invitation was sent", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const invitee = `e2e+${Date.now().toString().slice(-6)}@test.local`;

    await page.goto(`/${ORG}/team`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    await page
      .getByRole("button", { name: /invite member/i })
      .first()
      .click();

    // The invite dialog ("Invite a teammate").
    await expect(page.getByText(/invite a teammate/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByLabel(/email address/i).fill(invitee);
    // Role select defaults to MEMBER — leave it.
    await page.getByRole("button", { name: /send invitation/i }).click();

    // Success: the dialog flips to its "Invitation sent" result state.
    await expect(page.getByText(/invitation sent/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
