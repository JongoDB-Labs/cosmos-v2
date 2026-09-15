// @vitest-environment jsdom
// COSMOS-171 — the assignee picker's own comment promised filtering "by
// name/email", but the option label is `displayName ?? email`, so as soon as
// someone had a display name their address was unsearchable. Options can now
// carry a `searchText` the filter matches instead of the label, letting a picker
// match on something it never renders.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableMultiSelect } from "./searchable-multi-select";

beforeAll(() => {
  // base-ui Combobox needs these in jsdom or the popup won't open.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture =
    Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture =
    Element.prototype.releasePointerCapture || (() => {});
});

afterEach(cleanup);

const OPTIONS = [
  { value: "u1", label: "Ada Lovelace", searchText: "Ada Lovelace ada@x.co" },
  { value: "u2", label: "Grace Hopper", searchText: "Grace Hopper amazing@x.co" },
  // No searchText at all — must still filter on its label.
  { value: "u3", label: "Alan Turing" },
];

function Harness() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <SearchableMultiSelect
      value={value}
      onValueChange={setValue}
      options={OPTIONS}
      aria-label="Assignees"
      placeholder="Unassigned"
      searchPlaceholder="Search members…"
    />
  );
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Assignees"));
  expect(await screen.findAllByRole("option")).toHaveLength(OPTIONS.length);
  return { user, input: screen.getByPlaceholderText("Search members…") };
}

describe("SearchableMultiSelect — hidden search text (COSMOS-171)", () => {
  it("matches text that is searchable but not rendered", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "amazing@");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Grace Hopper");
    // The address stays out of the row — it is search text, not a label.
    expect(options[0]).not.toHaveTextContent("amazing@x.co");
  });

  it("still matches an option that carries no search text by its label", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "TURING");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Alan Turing");
  });
});
