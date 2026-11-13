// @vitest-environment node
// Shard 3 of the "every API route authenticates" sweep: see
// every-route-authenticates.db.test.ts for what it checks and why.
import { describe, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./route-sweep")).fakeNextHeaders);
vi.mock("next/cache", async () => (await import("./route-sweep")).fakeNextCache);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
  after: () => undefined,
}));
vi.mock("@/lib/auth/session", async (importOriginal) =>
  (await import("./route-sweep")).spyOnSession(await importOriginal<typeof import("@/lib/auth/session")>()),
);

import { defineRouteSweep } from "./route-sweep";

describe("every API route refuses a caller it hasn't identified (shard 3)", () => defineRouteSweep(2));
