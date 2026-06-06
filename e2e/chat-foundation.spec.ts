import { test, expect } from "@playwright/test";
import { getTestUserId } from "./fixtures/users";

const ORG_SLUG = "test-org";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test.describe("chat foundation — Phase 1 golden path", () => {
  test(
    "Alice mentions Bob in #general; Bob sees it live + bell increments",
    async ({ browser }) => {
      test.setTimeout(60_000);

      // Two isolated browser contexts = two distinct "users".
      const aliceContext = await browser.newContext();
      const bobContext = await browser.newContext();

      const alice = await aliceContext.newPage();
      const bob = await bobContext.newPage();

      try {
        // Sign in: POST to the test sign-in route from each page's request
        // context so the session cookie is stored in that context's cookie jar.
        // Include an Origin header to pass the same-origin CSRF check in proxy.ts.
        const signIn = async (page: typeof alice, email: string) => {
          const r = await page.request.post(`${BASE}/api/testenv/sign-in`, {
            data: { email },
            headers: { Origin: BASE },
          });
          if (!r.ok()) {
            throw new Error(
              `sign-in failed for ${email}: ${r.status()} ${r.statusText()}`,
            );
          }
        };

        await Promise.all([
          signIn(alice, "alice@test.local"),
          signIn(bob, "bob@test.local"),
        ]);

        // Resolve Bob's UUID so Alice can construct the mention token.
        const bobId = await getTestUserId(
          alice.request,
          BASE,
          "bob@test.local",
        );

        // Navigate both to the chat landing page.
        await Promise.all([
          alice.goto(`${BASE}/${ORG_SLUG}/chat`),
          bob.goto(`${BASE}/${ORG_SLUG}/chat`),
        ]);

        // Alice clicks #general in the sidebar.
        await alice.getByText("general").first().click();
        await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

        // Bob also opens #general.
        await bob.getByText("general").first().click();
        await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

        // Alice sends a mention. The composer placeholder is "Message general…".
        const composer = alice.getByPlaceholder(/^Message/i);
        await composer.fill(`Hello <@${bobId}>!`);
        await composer.press("Enter");

        // Bob's message list should show Alice's message in real time.
        // Use .first() in case prior test runs left older "Hello" messages in the channel.
        await expect(bob.getByText(/Hello/i).first()).toBeVisible({ timeout: 10_000 });

        // Bob's notification bell (aria-label="Notifications") should now have
        // an entry for the mention. Click it to open the dropdown.
        await bob.getByRole("button", { name: "Notifications" }).click();

        // The notification title is:
        //   "Alice mentioned you in #general"
        await expect(
          bob.getByText(/mentioned you in #general/i).first(),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await aliceContext.close();
        await bobContext.close();
      }
    },
  );
});
