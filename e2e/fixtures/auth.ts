import {
  test as base,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type AuthFixtures = {
  signInAs: (email: string) => Promise<void>;
};

/** Mirrors `use.baseURL` in playwright.config.ts. */
const DEFAULT_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

async function callTestSignIn(
  request: APIRequestContext,
  baseURL: string | undefined,
  email: string,
) {
  const origin = baseURL ?? DEFAULT_BASE_URL;
  const url = `${origin}/api/testenv/sign-in`;
  // Include Origin so the same-origin CSRF check in proxy.ts passes when
  // the request comes from Playwright's API request context (no browser Origin).
  const r = await request.post(url, {
    data: { email },
    headers: { Origin: origin },
  });
  if (!r.ok()) {
    throw new Error(
      `test sign-in failed for ${email}: ${r.status()} ${r.statusText()}`,
    );
  }
}

/**
 * Sign ONE specific page in.
 *
 * The `signInAs` fixture below is what an ordinary single-page spec should use.
 * A spec driving two browser contexts (two contexts = two users) builds its own
 * pages and so can never reach the fixture's `page` — this is the same POST,
 * exported, so those specs share one copy instead of each declaring its own.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  // The page's own request context, so the session cookie is stored in that
  // context's cookie jar.
  await callTestSignIn(page.request, DEFAULT_BASE_URL, email);
}

export const test = base.extend<AuthFixtures>({
  signInAs: async ({ page, baseURL }, use) => {
    await use(async (email: string) => {
      // Use the page's request context so cookies persist on the page's storage state.
      await callTestSignIn(
        page.request as APIRequestContext,
        baseURL,
        email,
      );
    });
  },
});

export { expect } from "@playwright/test";
