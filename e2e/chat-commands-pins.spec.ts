import { test, expect } from "./fixtures/auth";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ORG_SLUG = "test-org";

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

test.describe("chat phase 4 — slash commands + pins", () => {
  test("/me renders as an italic action line in the other client", async ({ browser }) => {
    test.setTimeout(60_000);

    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const alice = await aCtx.newPage();
    const bob = await bCtx.newPage();

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

      // Allow SSE connections to establish before Alice types.
      await bob.waitForTimeout(2_000);

      const stamp = Date.now().toString(36);

      // pressSequentially so React onChange fires (slash detection + value state).
      // Once the space is typed after "/me", detectSlash returns null (slashState clears),
      // so Enter will call send() which classifies "/me waves <stamp>" as an ACTION.
      await alice.getByPlaceholder(/message general/i).pressSequentially(
        `/me waves ${stamp}`,
        { delay: 15 },
      );
      await alice.getByPlaceholder(/message general/i).press("Enter");

      // message-item.tsx line 89: `* {author.displayName} {message.content}`
      // content = "waves <stamp>" (args after /me), displayName = "Alice"
      await expect(
        bob.getByText(new RegExp(`\\* Alice waves ${stamp}`)).first(),
      ).toBeVisible({ timeout: 6_000 });
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test("/ai posts a prompt + an assistant reply (or graceful unavailable notice)", async ({ browser }) => {
    test.setTimeout(90_000);

    const aCtx = await browser.newContext();
    const alice = await aCtx.newPage();

    try {
      await signIn(alice, "alice@test.local");

      await alice.goto(`${BASE}/${ORG_SLUG}/chat`);
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

      const stamp = Date.now().toString(36);

      // /ai is handledBy: "server" — the composer calls onCommand("ai", "say hello <stamp>")
      // which POSTs to /commands. The server then posts the prompt as a USER message.
      await alice.getByPlaceholder(/message general/i).pressSequentially(
        `/ai say hello ${stamp}`,
        { delay: 15 },
      );
      await alice.getByPlaceholder(/message general/i).press("Enter");

      // The prompt itself is posted as a visible USER message first
      await expect(
        alice.getByText(new RegExp(`say hello ${stamp}`)).first(),
      ).toBeVisible({ timeout: 10_000 });

      // Then either an ASSISTANT reply (🤖 Assistant badge) or a SYSTEM unavailable notice
      // commands/route.ts line 122: "🤖 AI is unavailable right now."
      await expect(
        alice.getByText(/🤖 Assistant/).first().or(
          alice.getByText(/🤖 AI is unavailable right now\./).first(),
        ),
      ).toBeVisible({ timeout: 70_000 });
    } finally {
      await aCtx.close();
    }
  });

  test("pin a message → other client's panel shows it + a SYSTEM notice", async ({ browser }) => {
    test.setTimeout(60_000);

    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const alice = await aCtx.newPage();
    const bob = await bCtx.newPage();

    try {
      await signIn(alice, "alice@test.local");
      await signIn(bob, "bob@test.local");

      // Alice sends a uniquely-stamped message
      await alice.goto(`${BASE}/${ORG_SLUG}/chat`);
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

      const stamp = Date.now().toString(36);
      await alice.getByPlaceholder(/message general/i).fill(`Pin me ${stamp}`);
      await alice.getByPlaceholder(/message general/i).press("Enter");
      await expect(
        alice.getByText(new RegExp(`Pin me ${stamp}`)).first(),
      ).toBeVisible({ timeout: 6_000 });

      // Bob opens the channel and sees the message via realtime / initial load
      await bob.goto(`${BASE}/${ORG_SLUG}/chat`);
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      await expect(
        bob.getByText(new RegExp(`Pin me ${stamp}`)).first(),
      ).toBeVisible({ timeout: 6_000 });

      // Allow SSE to be established before Alice pins
      await bob.waitForTimeout(2_000);

      // Hover the message row to reveal the hover actions (opacity-0 group-hover:opacity-100)
      // The <li> ancestor of the text node holds the "group" class that reveals buttons
      const row = alice
        .getByText(new RegExp(`Pin me ${stamp}`))
        .first()
        .locator("xpath=ancestor::li[1]");
      await row.hover();

      // message-item.tsx line 152: aria-label={isPinned ? "Unpin message" : "Pin message"}
      await row.getByLabel("Pin message").click();

      // pins/route.ts line 97: `📌 ${actorName} pinned a message`
      await expect(
        bob.getByText(/pinned a message/i).first(),
      ).toBeVisible({ timeout: 6_000 });

      // channel-header.tsx line 50: aria-label="Pinned messages"
      await bob.getByLabel("Pinned messages").click();
      await expect(
        bob.getByText(new RegExp(`Pin me ${stamp}`)).first(),
      ).toBeVisible({ timeout: 6_000 });
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });
});
