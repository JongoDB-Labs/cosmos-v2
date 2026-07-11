// @vitest-environment jsdom
// COSMOS-37 — searchable dropdowns. The shared <SearchableSelect> is the
// reusable type-ahead dropdown applied to large option lists (e.g. the parent
// picker in the work-item detail sheet, where a project can have hundreds of
// candidate parents). These tests lock its four acceptance criteria:
//   1. exposes a text input that filters the list as the user types
//   2. matches options by their visible label (case-insensitive, substring)
//   3. filtered results stay keyboard-navigable and selectable
//   4. clearing the search restores the full list
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableSelect } from "./searchable-select";

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
  { value: "1", label: "#1 Design the login page" },
  { value: "2", label: "#2 Build the public API" },
  { value: "3", label: "#3 Write documentation" },
  { value: "4", label: "#4 Deploy to production" },
];

function Harness({
  onChange,
  initial = null,
}: {
  onChange?: (v: string | null) => void;
  initial?: string | null;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <SearchableSelect
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={OPTIONS}
      aria-label="Parent"
      searchPlaceholder="Search issues…"
    />
  );
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Parent"));
  // All options visible before any query is typed.
  expect(await screen.findAllByRole("option")).toHaveLength(OPTIONS.length);
  return { user, input: screen.getByPlaceholderText("Search issues…") };
}

describe("SearchableSelect", () => {
  it("filters the list as the user types (AC1)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "documentation");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("#3 Write documentation");
  });

  it("matches by visible label case-insensitively as a substring (AC2)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    // "api" (lowercase) must match "...public API" (mixed case), and match the
    // substring in the middle of the label — not just a prefix.
    await user.type(input, "api");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("#2 Build the public API");
  });

  it("keeps filtered results keyboard-navigable and selectable (AC3)", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { user, input } = await open();

    await user.type(input, "deploy");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    // Highlight the sole match with the keyboard, then commit with Enter.
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("4");
  });

  it("restores the full list when the search is cleared (AC4)", async () => {
    render(<Harness />);
    const { user, input } = await open();

    await user.type(input, "deploy");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.clear(input);

    expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
  });
});
