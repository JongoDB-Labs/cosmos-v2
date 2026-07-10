import { describe, it, expect } from "vitest";
import { syncOpenDetail } from "@/lib/work-items/detail-sync";
import type { WorkItem } from "@/types/models";

const wi = (id: string, extra: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: id, ...extra }) as unknown as WorkItem;

describe("syncOpenDetail", () => {
  it("re-points the open sheet when the updated row is the one on screen", () => {
    const open = wi("C", { title: "old" });
    const updated = wi("C", { title: "new" });
    expect(syncOpenDetail(open, updated)).toBe(updated);
  });

  it("leaves the open sheet put when a DIFFERENT row updates (no re-parent hijack)", () => {
    const open = wi("C");
    const parentUpdate = wi("P");
    // COSMOS-67: patching the parent's children must not flip the sheet to the parent.
    expect(syncOpenDetail(open, parentUpdate)).toBe(open);
  });

  it("is a no-op when no sheet is open", () => {
    expect(syncOpenDetail(null, wi("P"))).toBeNull();
  });
});
