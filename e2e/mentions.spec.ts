import { test, expect } from "./fixtures/auth";

/**
 * @-tag-any-entity — chat surface. Typing `@` opens a type-grouped typeahead
 * across entity classes; picking inserts a token that renders as a clickable
 * deep-link chip. Requires the e2e DB seeded with the "Falcon" fixtures
 * (project FAL + work items + note) and test-org / alice.
 */
const ORG_SLUG = "test-org";

async function openGeneral(page: import("@playwright/test").Page) {
  await page.goto(`/${ORG_SLUG}/chat`);
  await page.getByText("general").first().click();
  const composer = page.getByPlaceholder(/^Message/i);
  await composer.click();
  return composer;
}

test.describe("@-tag any entity — chat", () => {
  test("typeahead spans entity types; picking a project renders a deep-link chip", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    const composer = await openGeneral(page);
    await composer.pressSequentially("@Falcon", { delay: 30 });

    // One query surfaces multiple entity classes: a work item AND the project.
    await expect(page.getByRole("button", { name: /Falcon radar/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Falcon Program/ })).toBeVisible();

    // Pick the project → send → chip renders as a link to the project page.
    await page.getByRole("button", { name: /Falcon Program/ }).click();
    await composer.press("Enter");

    const chip = page.getByRole("link", { name: /Falcon Program/ }).last();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("href", /\/test-org\/projects\/FAL/);
  });

  test("picking a work item renders a chip linking to the item", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    const composer = await openGeneral(page);
    await composer.pressSequentially("@telemetry", { delay: 30 });

    await page.getByRole("button", { name: /Falcon telemetry/ }).click();
    await composer.press("Enter");

    const chip = page.getByRole("link", { name: /Falcon telemetry/ }).last();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("href", /\/issues\?item=/);

    // Deep-link: clicking the chip lands on /issues and auto-opens the item's
    // detail sheet (fetched by id even though it's not on the current page).
    await chip.click();
    await expect(page).toHaveURL(/\/issues/);
    await expect(
      page.getByRole("heading", { name: /Falcon telemetry pipeline/ }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("legacy person mention still renders", async ({ page, signInAs }) => {
    await signInAs("alice@test.local");
    const composer = await openGeneral(page);
    await composer.pressSequentially("@bob", { delay: 30 });
    await page.getByRole("button", { name: /bob/i }).first().click();
    await composer.press("Enter");

    await expect(page.getByText(/@Bob/i).last()).toBeVisible();
  });
});

test.describe("@-tag any entity — assistant", () => {
  test("@ in the assistant composer inserts an id-only token", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    await page.goto(`/${ORG_SLUG}/assistant`);

    const composer = page.getByPlaceholder(/type a message/i).first();
    await composer.click();
    await composer.pressSequentially("@Falcon", { delay: 40 });

    await page.getByRole("button", { name: /Falcon Program/ }).click();

    // Token is inserted id-only (never expanded to content client-side).
    await expect(composer).toHaveValue(/<@project:[0-9a-f-]+>/);
  });
});

test.describe("@-tag any entity — notes (Lexical)", () => {
  test("@ in a note inserts a typed entity chip", async ({ page, signInAs }) => {
    await signInAs("alice@test.local");
    await page.goto(`/${ORG_SLUG}/notes`);
    await page.getByRole("button", { name: /new note/i }).click();

    const editor = page.getByRole("textbox", { name: /note content/i });
    await editor.click();
    await editor.pressSequentially("@Falcon", { delay: 40 });

    // Lexical typeahead menu (portal) with grouped/typed options.
    await page.getByRole("option", { name: /Falcon Program/ }).click();

    // The inserted MentionNode renders as a typed chip in the editor.
    const chip = page.locator('[data-mention-type="project"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Falcon Program/);
  });
});

test.describe("@-tag any entity — backlinks", () => {
  test("a project's settings shows 'Mentioned in' with deep-linked sources", async ({
    page,
    signInAs,
  }) => {
    // The FAL project has been referenced from a chat message, a comment, and a
    // note by the API smoke steps — the panel lists them.
    await signInAs("alice@test.local");
    await page.goto(`/${ORG_SLUG}/projects/FAL/settings`);

    await expect(page.getByText(/Mentioned in \(\d+\)/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Falcon plan/ })).toBeVisible();
  });
});
