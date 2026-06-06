# Cosmos E2E tests

These tests require:

1. A running dev server on `E2E_BASE_URL` (default `http://localhost:3000`) launched with `E2E_TEST_AUTH=1` set in the environment.
2. Two seeded test users in the same org with known emails (e.g. `alice@test.local`, `bob@test.local`). Ensure each is a member of a test org via `prisma/seed/`.

## Running

```bash
# In one terminal:
E2E_TEST_AUTH=1 npm run dev

# In another:
npx playwright test
```

Authenticated specs use the fixture from `e2e/fixtures/auth.ts`:

```ts
import { test, expect } from "./fixtures/auth";

test("foo", async ({ page, signInAs }) => {
  await signInAs("alice@test.local");
  await page.goto("/test-org/chat");
  // ...
});
```
