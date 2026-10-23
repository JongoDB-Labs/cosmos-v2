// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { TransitionDialog } from "./transition-dialog";
import type { CustomField } from "@/types/models";

// base-ui's Select portals its popup, which jsdom cannot drive: a native
// select keeps the component's own value handling under test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ items, value, onValueChange }: { items: Record<string, string>; value: string | null; onValueChange: (v: string) => void }) => (
    <select aria-label="choice" value={value ?? ""} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">—</option>
      {Object.entries(items).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

afterEach(cleanup);

const CANCEL = [
  { field: { system: "cancelReason" as const }, required: true },
  { field: { system: "cancelNote" as const }, required: false },
];

describe("TransitionDialog", () => {
  it("renders the Cancel transition's input with the cancel dialog's choices and labels", () => {
    const onSubmit = vi.fn();
    render(
      <TransitionDialog
        open
        transition={{ id: "cancel", name: "Cancel" }}
        fields={CANCEL}
        pending={false}
        onSubmit={onSubmit}
        onClose={() => {}}
        title="Cancel this work?"
        submitLabel="Mark cancelled"
        closeLabel="Keep it"
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Reason" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Overcome by events/ }).getAttribute("aria-checked")).toBe("true");

    // Other needs a note: the submit stays disabled until one is written.
    fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
    const submit = screen.getByRole("button", { name: "Mark cancelled" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "  superseded  " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ "system:cancelReason": "OTHER", "system:cancelNote": "superseded" });
  });

  it("blocks submit until every required field has a value, including custom ones", () => {
    const rootCause: CustomField = {
      id: "f1",
      orgId: "o",
      projectId: null,
      name: "Root cause",
      key: "root_cause",
      fieldType: "TEXT",
      options: [],
      required: true,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as CustomField;
    const onSubmit = vi.fn();
    render(
      <TransitionDialog
        open
        transition={{ id: "resolve", name: "Resolve" }}
        fields={[
          { field: { system: "resolution" }, required: true, options: [{ value: "Fixed", label: "Fixed" }, { value: "Won't do", label: "Won't do" }] },
          { field: { custom: "root_cause" }, required: true },
        ]}
        customFields={[rootCause]}
        pending={false}
        onSubmit={onSubmit}
        onClose={() => {}}
      />,
    );
    const submit = screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("choice"), { target: { value: "Fixed" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "race in the cache" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ "system:resolution": "Fixed", "custom:root_cause": "race in the cache" });
  });

  it("closing calls onClose and submits nothing", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <TransitionDialog open transition={{ id: "c", name: "Cancel" }} fields={CANCEL} pending={false} onSubmit={onSubmit} onClose={onClose} closeLabel="Keep it" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
