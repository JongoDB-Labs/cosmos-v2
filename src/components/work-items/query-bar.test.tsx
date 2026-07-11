// @vitest-environment jsdom
// COSMOS-59 — the Jira-like query bar. Locks the three user-facing contracts:
// autocomplete suggests fields/values, Enter applies the parsed filter, and an
// invalid clause surfaces a parse error instead of failing silently.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Priority } from "@prisma/client";
import { QueryBar } from "./query-bar";
import type { ParsedJql, QueryVocab } from "@/lib/work-items/query/jql";

const VOCAB: QueryVocab = {
  project: [
    { value: "p_fsc", label: "Falcon Shield", aliases: ["FSC"] },
    { value: "p_atn", label: "Atlantis", aliases: ["ATN"] },
  ],
  type: [{ value: "t_bug", label: "Bug", aliases: ["bug"] }],
  status: [{ value: "done", label: "Done", aliases: ["done"] }],
  priority: [
    { value: Priority.HIGH, label: "High" },
    { value: Priority.LOW, label: "Low" },
  ],
  assignee: [{ value: "u_ada", label: "Ada Lovelace" }],
  label: [{ value: "urgent", label: "urgent" }],
  cycle: [],
  currentUserId: "u_ada",
};

function Harness({ onApply }: { onApply: (p: ParsedJql) => void }) {
  const [value, setValue] = useState("");
  return <QueryBar value={value} onValueChange={setValue} vocab={VOCAB} onApply={onApply} />;
}

afterEach(cleanup);

describe("QueryBar (COSMOS-59)", () => {
  it("suggests field names as you type", async () => {
    const user = userEvent.setup();
    render(<Harness onApply={vi.fn()} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "pr");

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.join(" ")).toMatch(/project/);
    expect(options.join(" ")).toMatch(/priority/);
  });

  it("completes a value from autocomplete and applies the parsed filter", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(<Harness onApply={onApply} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;

    await user.type(input, "project = fal");
    // The matching project is offered…
    const option = await screen.findByText("Falcon Shield");
    await user.click(option);
    // …and echoed back into the box as `project = FSC `.
    expect(input.value).toBe("project = FSC ");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApply).toHaveBeenCalledTimes(1);
    const parsed = onApply.mock.calls[0][0] as ParsedJql;
    expect(parsed.filter.projectIds).toEqual(["p_fsc"]);
  });

  it("applies free text as the text filter on Enter", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(<Harness onApply={onApply} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "payment timeout");
    fireEvent.keyDown(input, { key: "Enter" });

    const parsed = onApply.mock.calls[0][0] as ParsedJql;
    expect(parsed.filter.text).toBe("payment timeout");
    expect(parsed.filter.projectIds).toBeUndefined();
  });

  it("surfaces a parse error for an invalid value", async () => {
    const user = userEvent.setup();
    render(<Harness onApply={vi.fn()} />);
    const input = screen.getByRole("combobox");

    // Type an unknown project, then blur so the error (suppressed while
    // autocomplete is active) is shown.
    await user.type(input, "project = Nope");
    fireEvent.blur(input);

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/No project matches "Nope"/);
  });
});
