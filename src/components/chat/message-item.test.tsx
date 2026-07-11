// @vitest-environment jsdom
//
// MessageItem timestamp behavior (FR 78b5b1bd): a minute-level time shows only
// when the message opens a new time group; the precise (second-level) time is
// revealed by clicking the message.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MessageItem } from "./message-item";
import { formatMinuteTime, formatPreciseTimestamp } from "@/lib/chat/message-time";
import type { ChatMessageDto } from "@/hooks/use-chat-messages";
import type { RefMap } from "./markdown-content";

afterEach(cleanup);

const CREATED_AT = new Date(2026, 0, 2, 14, 5, 30).toISOString();

function makeMessage(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: "m1",
    channelId: "c1",
    authorId: "u1",
    content: "hello world",
    kind: "USER",
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: CREATED_AT,
    reactions: [],
    attachments: [],
    replyCount: 0,
    ...overrides,
  };
}

function renderItem(props: { showTimestamp?: boolean; grouped?: boolean } = {}) {
  const noop = vi.fn();
  return render(
    <MessageItem
      message={makeMessage()}
      author={{ displayName: "Ada", avatarUrl: null }}
      isOwn={false}
      currentUserId="me"
      refMap={new Map() as RefMap}
      isPinned={false}
      grouped={props.grouped ?? false}
      showTimestamp={props.showTimestamp ?? true}
      onEdit={noop}
      onDelete={noop}
      onReact={noop}
      onOpenThread={noop}
      onTogglePin={noop}
    />,
  );
}

describe("MessageItem timestamps (FR 78b5b1bd)", () => {
  it("shows the minute-level time when the message opens a time group", () => {
    renderItem({ showTimestamp: true });
    expect(screen.getByText(formatMinuteTime(CREATED_AT))).toBeInTheDocument();
  });

  it("hides the timestamp for messages inside a burst", () => {
    renderItem({ showTimestamp: false });
    expect(screen.queryByText(formatMinuteTime(CREATED_AT))).toBeNull();
    // The precise timestamp is not shown until the message is clicked.
    expect(
      screen.queryByText(formatPreciseTimestamp(CREATED_AT)),
    ).toBeNull();
  });

  it("reveals the precise timestamp when the message is clicked", () => {
    renderItem({ showTimestamp: false });
    fireEvent.click(screen.getByText("hello world"));
    expect(
      screen.getByText(formatPreciseTimestamp(CREATED_AT)),
    ).toBeInTheDocument();
    // Clicking again hides it.
    fireEvent.click(screen.getByText("hello world"));
    expect(
      screen.queryByText(formatPreciseTimestamp(CREATED_AT)),
    ).toBeNull();
  });
});
