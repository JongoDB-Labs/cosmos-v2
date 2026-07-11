// @vitest-environment jsdom
// COSMOS-37 — searchable dropdowns. <SearchableMultiSelect> is the multi-select
// sibling of <SearchableSelect>: the reusable type-ahead dropdown applied to
// large option lists you pick SEVERAL from (e.g. the assignee picker in the
// work-item detail sheet, where an org can have hundreds of members). These
// tests lock its four acceptance criteria:
//   1. exposes a text input that filters the list as the user types
//   2. matches options by their visible label (case-insensitive, substring)
//   3. filtered results stay keyboard-navigable and selectable
//   4. clearing the search restores the full list
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS = [
  { value: "u1", label: "Ada Lovelace" },
  { value: "u2", label: "Grace Hopper" },
  { value: "u3", label: "Alan Turing" },
  { value: "u4", label: "Katherine Johnson" },
];

function Harness({
  onChange,
  initial = [],
}: {
  onChange?: (v: string[]) => void;
  initial?: string[];
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <SearchableMultiSelect
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
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
  // All options visible before any query is typed.
  expect(await screen.findAllByRole("option")).toHaveLength(OPTIONS.length);
  return { user, input: screen.getByPlaceholderText("Search members…") };
}

describe("SearchableMultiSelect", () => {
  it("filters the list as the user types (AC1)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "hopper");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Grace Hopper");
  });

  it("matches by visible label case-insensitively as a substring (AC2)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    // "turing" (lowercase) must match "Alan Turing" (mixed case), matching a
    // substring at the END of the label — not just a prefix.
    await user.type(input, "turing");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Alan Turing");
  });

  it("keeps filtered results keyboard-navigable and selectable, and allows several (AC3)", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { user, input } = await open();

    // Filter to one match, highlight it with the keyboard, commit with Enter.
    await user.type(input, "ada");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["u1"]);

    // Multi-select: the popup stays open and the filter clears, so a second
    // pick can be added to the first (order preserved, newest appended).
    await user.type(input, "katherine");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["u1", "u4"]);
  });

  it("toggles an already-selected option off (AC3)", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={["u1", "u2"]} />);
    const { user } = await open();

    // Click the already-selected "Ada Lovelace" to remove it; the other stays.
    await user.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    expect(onChange).toHaveBeenLastCalledWith(["u2"]);
  });

  it("restores the full list when the search is cleared (AC4)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "ada");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.clear(input);

    expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
  });
});
