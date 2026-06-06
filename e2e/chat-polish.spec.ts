import { test, expect } from "@playwright/test";

const ORG_SLUG = "test-org";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

async function signIn(page: import("@playwright/test").Page, email: string) {
  const r = await page.request.post(`${BASE}/api/testenv/sign-in`, {
    data: { email },
    headers: { Origin: BASE },
  });
  if (!r.ok()) {
    throw new Error(
      `sign-in failed for ${email}: ${r.status()} ${r.statusText()}`,
    );
  }
}

/**
 * Look up the test-org's orgId using Alice's authenticated session.
 * POST /api/testenv/sign-in first, then GET /api/v1/orgs.
 */
async function getOrgId(page: import("@playwright/test").Page): Promise<string> {
  const r = await page.request.get(`${BASE}/api/v1/orgs`);
  if (!r.ok()) throw new Error(`GET /api/v1/orgs failed: ${r.status()}`);
  const j = await r.json();
  const orgs: Array<{ id: string; slug: string }> = j.data ?? j;
  const org = orgs.find((o) => o.slug === ORG_SLUG);
  if (!org) throw new Error(`org with slug "${ORG_SLUG}" not found`);
  return org.id;
}

test.describe("chat polish — Phase 3", () => {
  test("Bob sees 'Alice is typing…' then it clears", async ({ browser }) => {
    test.setTimeout(60_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      await signIn(alice, "alice@test.local");
      await signIn(bob, "bob@test.local");

      await alice.goto(`${BASE}/${ORG_SLUG}/chat`);
      await bob.goto(`${BASE}/${ORG_SLUG}/chat`);

      // Both open #general
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

      // Allow SSE connections to establish before Alice starts typing.
      // The leader-election + EventSource open is async; give it ~2s.
      await bob.waitForTimeout(2_000);

      // Alice types in the composer character-by-character so React's onChange
      // fires and emitTyping() is called → POST /typing → SSE to Bob.
      // fill() bypasses synthetic events; pressSequentially() does not.
      const aliceComposer = alice.getByPlaceholder(/^Message/i);
      await aliceComposer.click();
      await aliceComposer.pressSequentially("typing a draft message", { delay: 30 });

      // Bob should see "Alice is typing…" via SSE within ~7s
      await expect(bob.getByText("Alice is typing…")).toBeVisible({ timeout: 7_000 });

      // Clear the composer by selecting all and deleting — the indicator expires
      // after TYPING_TTL_MS (5s) since no further typing heartbeat arrives.
      await aliceComposer.selectText();
      await aliceComposer.press("Delete");
      // TTL = 5s; prune runs every 1s; allow 10s total
      await expect(bob.getByText("Alice is typing…")).toBeHidden({ timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("read-receipt avatar appears after Bob reads Alice's message", async ({ browser }) => {
    test.setTimeout(60_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      await signIn(alice, "alice@test.local");
      await signIn(bob, "bob@test.local");

      await alice.goto(`${BASE}/${ORG_SLUG}/chat`);
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

      // Alice sends a uniquely-stamped message
      const stamp = Date.now().toString(36);
      const content = `Receipt test ${stamp}`;
      await alice.getByPlaceholder(/^Message/i).fill(content);
      await alice.getByPlaceholder(/^Message/i).press("Enter");
      await expect(alice.getByText(content).first()).toBeVisible({ timeout: 5_000 });

      // Bob opens the channel — this triggers a read-state mark
      await bob.goto(`${BASE}/${ORG_SLUG}/chat`);
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      await expect(bob.getByText(content).first()).toBeVisible({ timeout: 5_000 });

      // Alice should now see "Seen by Bob" receipt avatar on her message.
      // ReadReceiptAvatars renders: <span title="Seen by Bob">
      await expect(alice.locator('[title="Seen by Bob"]').first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("presence: Bob shows online in the snapshot after connecting", async ({ browser }) => {
    test.setTimeout(60_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      await signIn(alice, "alice@test.local");
      await signIn(bob, "bob@test.local");

      // Resolve Bob's userId
      const bobUserIdResp = await alice.request.get(
        `${BASE}/api/testenv/user-id?email=bob@test.local`,
      );
      if (!bobUserIdResp.ok()) throw new Error("could not resolve bob userId");
      const { userId: bobId } = await bobUserIdResp.json();

      // Resolve orgId using Alice's authenticated session
      const orgId = await getOrgId(alice);

      // Bob comes online by navigating into the app (SSE /events connects → presence.connect)
      await bob.goto(`${BASE}/${ORG_SLUG}/chat`);
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

      // Poll the presence snapshot until Bob appears (SSE connect is async; allow up to 10s)
      await expect
        .poll(
          async () => {
            const r = await alice.request.get(
              `${BASE}/api/v1/orgs/${orgId}/chat/presence`,
            );
            if (!r.ok()) return [];
            const j = await r.json();
            return (j.data?.online ?? j.online ?? []) as string[];
          },
          { timeout: 10_000, intervals: [500, 500, 1000, 1000, 1000] },
        )
        .toContain(bobId);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
