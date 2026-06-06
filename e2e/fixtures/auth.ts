import { test as base, type APIRequestContext } from "@playwright/test";

type AuthFixtures = {
  signInAs: (email: string) => Promise<void>;
};

async function callTestSignIn(
  request: APIRequestContext,
  baseURL: string | undefined,
  email: string,
) {
  const base = baseURL ?? "http://localhost:3000";
  const url = `${base}/api/testenv/sign-in`;
  // Include Origin so the same-origin CSRF check in proxy.ts passes when
  // the request comes from Playwright's API request context (no browser Origin).
  const r = await request.post(url, {
    data: { email },
    headers: { Origin: base },
  });
  if (!r.ok()) {
    throw new Error(
      `test sign-in failed for ${email}: ${r.status()} ${r.statusText()}`,
    );
  }
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
