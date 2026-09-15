import { describe, it, expect, vi, beforeEach } from "vitest";
import { copyLinkAction, archiveAction } from "./item-actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * Two actions reported missing in the same week, for the same underlying
 * reason — they existed somewhere and not on the surface the reporter was
 * looking at.
 *
 * Built once here rather than per surface, so these tests are the single place
 * their behaviour is pinned.
 */

const item = { id: "w1" };

beforeEach(() => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
  vi.stubGlobal("window", { location: { origin: "https://cosmos.example" } });
});

describe("copyLinkAction", () => {
  it("copies a link to the ITEM, not the project it lives in", async () => {
    const [action] = copyLinkAction(item, "acme");
    action.onClick!();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://cosmos.example/acme/issues?item=w1",
    );
  });

  it("renders no row at all when there is no org in the URL", () => {
    // A row that silently does nothing is worse than no row; ActionMenu drops
    // empty groups, so the menu simply does not grow a dead entry.
    expect(copyLinkAction(item, null)).toEqual([]);
    expect(copyLinkAction(item, undefined)).toEqual([]);
    expect(copyLinkAction(item, "")).toEqual([]);
  });

  it("does not throw when the clipboard is unavailable", () => {
    // Insecure origin, or permission denied. The action should be inert, not
    // an unhandled rejection — and must not claim success.
    vi.stubGlobal("navigator", {});
    const [action] = copyLinkAction(item, "acme");
    expect(() => action.onClick!()).not.toThrow();
  });
});

describe("archiveAction", () => {
  const onToggle = vi.fn();
  beforeEach(() => onToggle.mockClear());

  it("offers Archive for an active item, and sends a timestamp", () => {
    const [row] = archiveAction({ item: { id: "w1" }, canEdit: true, onToggle });
    expect(row.label).toBe("Archive");
    row.onClick!();
    const sent = onToggle.mock.calls[0][0];
    expect(typeof sent).toBe("string");
    expect(Number.isNaN(Date.parse(sent))).toBe(false);
  });

  it("offers Restore for an archived item, and sends null", () => {
    const [row] = archiveAction({
      item: { id: "w1", archivedAt: "2026-09-14T00:00:00.000Z" },
      canEdit: true,
      onToggle,
    });
    expect(row.label).toBe("Restore from archive");
    row.onClick!();
    expect(onToggle).toHaveBeenCalledWith(null);
  });

  it("offers nothing without ITEM_UPDATE", () => {
    expect(archiveAction({ item: { id: "w1" }, canEdit: false, onToggle })).toEqual([]);
  });

  it("is gated on EDIT, not DELETE — that is the whole point", () => {
    // Deleting stays ADMIN-only. Archiving is reversible, which is what lets it
    // sit at the lower bar: the person who made five duplicates by accident can
    // clear them up without being handed the ability to destroy anyone's work.
    const rows = archiveAction({ item: { id: "w1" }, canEdit: true, onToggle });
    expect(rows).toHaveLength(1);
  });

  it("disables the row while a save is in flight", () => {
    const [row] = archiveAction({ item: { id: "w1" }, canEdit: true, pending: true, onToggle });
    expect(row.disabled).toBe(true);
  });

  it("treats a null archivedAt as active — the negative control", () => {
    // `archivedAt: null` is the shape the API returns for a live item; reading
    // it as archived would show "Restore" on everything.
    const [row] = archiveAction({ item: { id: "w1", archivedAt: null }, canEdit: true, onToggle });
    expect(row.label).toBe("Archive");
  });
});
