// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: ({ ariaLabel, onChange, initialMarkdown }: { ariaLabel: string; onChange: (v: string) => void; initialMarkdown: string }) => (
    <textarea aria-label={ariaLabel} defaultValue={initialMarkdown} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { CommentItem } from "./comment-item";

afterEach(cleanup);

const props = {
  authorName: "Carol",
  createdAt: "2026-10-23T10:00:00.000Z",
  edited: false,
  content: "first",
  refMap: new Map(),
  orgId: "o1",
  mentionLabels: new Map(),
  canEdit: true,
  canDelete: true,
  onDelete: vi.fn(),
};

describe("CommentItem", () => {
  it("saves an edit and leaves edit mode only when the save is taken", async () => {
    const onSave = vi.fn(async () => false);
    render(<CommentItem {...props} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    const box = () => screen.queryByRole("textbox", { name: "Edit comment" });
    fireEvent.change(box()!, { target: { value: "  second  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("second"));
    // Refused: still editing, so the words are not lost.
    expect(box()).toBeInTheDocument();

    onSave.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(box()).toBeNull());
  });

  it("offers only the controls the viewer has", () => {
    render(<CommentItem {...props} canEdit={false} onSave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeInTheDocument();
  });
});
