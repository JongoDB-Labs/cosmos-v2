import { test, expect } from "./fixtures/auth";
import { getTestUserId } from "./fixtures/users";

const ORG_SLUG = "test-org";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test.describe("chat richness — Phase 2", () => {
  test("Alice reacts to a message; Bob sees the count update", async ({ browser }) => {
    test.setTimeout(60_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      // Sign in both users
      const signIn = async (page: typeof alice, email: string) => {
        const r = await page.request.post(`${BASE}/api/testenv/sign-in`, {
          data: { email },
          headers: { Origin: BASE },
        });
        if (!r.ok()) {
          throw new Error(`sign-in failed for ${email}: ${r.status()} ${r.statusText()}`);
        }
      };

      await Promise.all([
        signIn(alice, "alice@test.local"),
        signIn(bob, "bob@test.local"),
      ]);

      // Resolve Bob's UUID so Alice can construct the mention token
      const bobId = await getTestUserId(alice.request, BASE, "bob@test.local");

      // Navigate both to the chat landing page
      await Promise.all([
        alice.goto(`${BASE}/${ORG_SLUG}/chat`),
        bob.goto(`${BASE}/${ORG_SLUG}/chat`),
      ]);

      // Both open #general
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      // Let Bob's SSE subscription connect before Alice sends — otherwise a
      // message sent before his stream is live is never delivered to him (the
      // real cause of the cross-context flake, not slow propagation). Mirrors
      // the connect-settle wait in chat-commands-pins.spec.ts.
      await bob.waitForTimeout(2_000);

      // Alice sends a message
      const stamp = Date.now().toString(36);
      const content = `Reactions test ${stamp} <@${bobId}>`;
      const composer = alice.getByPlaceholder(/^Message/i);
      await composer.fill(content);
      await composer.press("Enter");

      // Both views see the message
      await expect(alice.getByText(new RegExp(`Reactions test ${stamp}`)).first()).toBeVisible({ timeout: 5_000 });
      // Cross-context: Bob receives Alice's message via SSE. Allow extra headroom
      // for SSE propagation between two browser contexts under CI load.
      await expect(bob.getByText(new RegExp(`Reactions test ${stamp}`)).first()).toBeVisible({ timeout: 15_000 });

      // Alice hovers her message and clicks "Add reaction"
      const aliceMsg = alice
        .getByText(new RegExp(`Reactions test ${stamp}`))
        .first()
        .locator("xpath=ancestor::li")
        .first();
      await aliceMsg.hover();
      await aliceMsg.getByLabel(/Add reaction/i).click();

      // Pick 👍 from the popover
      // aria-label in emoji-picker.tsx: `React with ${e}`
      await alice.getByLabel("React with 👍").click();

      // Bob sees the 👍 count = 1 within a few seconds via SSE
      // aria-label in reaction-bar.tsx: `${emoji} ${count}, ${isOwn ? "click to remove" : "click to add"}`
      // Bob is not the reactor so he sees "👍 1, click to add"
      await expect(bob.getByLabel(/👍 1,/).first()).toBeVisible({ timeout: 8_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("Alice opens a thread and replies; Bob sees the reply count badge", async ({ browser }) => {
    test.setTimeout(60_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    try {
      // Sign in both users
      const signIn = async (page: typeof alice, email: string) => {
        const r = await page.request.post(`${BASE}/api/testenv/sign-in`, {
          data: { email },
          headers: { Origin: BASE },
        });
        if (!r.ok()) {
          throw new Error(`sign-in failed for ${email}: ${r.status()} ${r.statusText()}`);
        }
      };

      await Promise.all([
        signIn(alice, "alice@test.local"),
        signIn(bob, "bob@test.local"),
      ]);

      // Navigate both to the chat landing page
      await Promise.all([
        alice.goto(`${BASE}/${ORG_SLUG}/chat`),
        bob.goto(`${BASE}/${ORG_SLUG}/chat`),
      ]);

      // Both open #general
      await alice.getByText("general").first().click();
      await alice.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      await bob.getByText("general").first().click();
      await bob.waitForURL(/\/chat\/[0-9a-f-]{36}$/i, { timeout: 10_000 });
      // Let Bob's SSE subscription connect before Alice sends — otherwise a
      // message sent before his stream is live is never delivered to him (the
      // real cause of the cross-context flake, not slow propagation). Mirrors
      // the connect-settle wait in chat-commands-pins.spec.ts.
      await bob.waitForTimeout(2_000);

      // Alice sends a thread parent message
      const stamp = Date.now().toString(36);
      const content = `Thread parent ${stamp}`;
      const composer = alice.getByPlaceholder(/^Message/i);
      await composer.fill(content);
      await composer.press("Enter");

      // Both views see the message
      await expect(alice.getByText(new RegExp(`Thread parent ${stamp}`)).first()).toBeVisible({ timeout: 5_000 });
      // Cross-context: Bob receives Alice's message via SSE. Allow extra headroom
      // for SSE propagation between two browser contexts under CI load.
      await expect(bob.getByText(new RegExp(`Thread parent ${stamp}`)).first()).toBeVisible({ timeout: 15_000 });

      // Alice hovers + clicks the "Reply in thread" button
      // aria-label in message-item.tsx: "Reply in thread"
      const aliceMsg = alice
        .getByText(new RegExp(`Thread parent ${stamp}`))
        .first()
        .locator("xpath=ancestor::li")
        .first();
      await aliceMsg.hover();
      await aliceMsg.getByLabel(/Reply in thread/i).click();

      // The thread pane opens with header "Thread"
      // In thread-pane.tsx: <span className="text-sm font-semibold">Thread</span>
      await expect(alice.getByText("Thread").first()).toBeVisible({ timeout: 5_000 });

      // Send a reply from the thread composer
      // In thread-pane.tsx: channelLabel={`thread on ${parentMessage.content.slice(0, 20)}…`}
      // Composer's placeholder: "Message ${channelLabel}…" or similar — check by using /thread on/i
      const threadComposer = alice.getByPlaceholder(/thread on/i);
      await threadComposer.fill(`Reply ${stamp}`);
      await threadComposer.press("Enter");

      // Bob's main feed should show "↳ 1 reply" badge on the parent message
      // In message-item.tsx: "↳ {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}"
      await expect(bob.getByText(/↳\s*1\s*reply/i).first()).toBeVisible({ timeout: 8_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
