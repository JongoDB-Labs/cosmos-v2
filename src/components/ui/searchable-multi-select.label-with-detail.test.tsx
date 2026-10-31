// @vitest-environment jsdom
// The value pickers in the CQL query builder set `searchText` to a row's DETAIL
// alone (`query-chips.tsx` → `push(v, s.label, s.detail)`), because the detail is
// the part that isn't rendered. The filter read `searchText ?? label`, so
// supplying a detail REPLACED the label instead of widening it — and typing a
// sprint's own name into the Sprint picker matched nothing. The suggestion hook
// fetches one page with `prefix: ""` and never re-queries, so this client-side
// filter is the only narrowing there is: an interval you cannot type the name of
// is an interval you cannot pick.
//
// COSMOS-171's own fixture hid this by duplicating the label INTO the searchText
// ("Ada Lovelace ada@x.co"), which is also what `member-picker.ts` does by hand.
// This spec pins the contract the component documents — "matching against each
// item's label, widened to its optional searchText" — with a detail-only row.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableMultiSelect } from "./searchable-multi-select";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
});

afterEach(cleanup);

// Shaped exactly like a /cql/suggest page for `sprint`: label = interval name,
// detail = "PROJECT · status", which is what the picker passes as searchText.
const OPTIONS = [
  { value: "PI 2026.4", label: "PI 2026.4", searchText: "ACME · active" },
  { value: "Sprint 31", label: "Sprint 31", searchText: "ACME · planned" },
  { value: "Hardening", label: "Hardening", searchText: "BETA · closed" },
];

function Harness() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <SearchableMultiSelect
      value={value}
      onValueChange={setValue}
      options={OPTIONS}
      aria-label="Sprint values"
      placeholder="Pick values…"
      searchPlaceholder="Search…"
    />
  );
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Sprint values"));
  expect(await screen.findAllByRole("option")).toHaveLength(OPTIONS.length);
  return { user, input: screen.getByPlaceholderText("Search…") };
}

describe("SearchableMultiSelect — a detail widens the label, it does not replace it", () => {
  it("finds an option by its own label when searchText carries only a detail", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "Sprint 31");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Sprint 31");
  });

  it("still finds an option by the detail it never renders", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "BETA");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Hardening");
    expect(options[0]).not.toHaveTextContent("BETA");
  });
});
