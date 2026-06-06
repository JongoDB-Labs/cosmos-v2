// Resolve test-user ids from the DB via the E2E_TEST_AUTH-gated endpoint.
// Used by chat-foundation.spec.ts to construct <@uuid> mention tokens.

import type { APIRequestContext } from "@playwright/test";

export async function getTestUserId(
  request: APIRequestContext,
  baseURL: string | undefined,
  email: string,
): Promise<string> {
  const r = await request.get(
    `${baseURL ?? ""}/api/testenv/user-id?email=${encodeURIComponent(email)}`,
  );
  if (!r.ok()) {
    throw new Error(
      `could not resolve user id for ${email}: ${r.status()} ${r.statusText()}`,
    );
  }
  const j = await r.json();
  return j.userId as string;
}
