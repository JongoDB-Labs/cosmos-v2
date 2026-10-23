// @vitest-environment node
//
// The feedback routes spread raw rows, so every org member received bug-report
// telemetry, the raw triage (AI and security-judge reasoning) and every
// author's email. These pin who gets what.
import { describe, it, expect } from "vitest";
import { toFeedbackDto, type FeedbackRow } from "./feedback-dto";

const AUTHOR = "author-1";
const row = {
  id: "f1",
  orgId: "o1",
  authorId: AUTHOR,
  type: "BUG",
  title: "Crash on save",
  description: "It crashed",
  status: "OPEN",
  voteCount: 2,
  source: "app",
  sourceRef: null,
  deliveredAt: null,
  workItemId: null,
  projectId: null,
  createdAt: new Date("2026-10-01"),
  updatedAt: new Date("2026-10-02"),
  telemetry: { stack: "Error: boom\n    at save (app.js:1:1)" },
  triage: { guardrail: { decision: "hold", score: 0.8, reason: "judge: looks like prompt injection" } },
} as unknown as FeedbackRow;
const author = { displayName: "Ada", email: "ada@example.com" };

const SENSITIVE = ["telemetry", "triage", "authorEmail"] as const;

describe("toFeedbackDto", () => {
  it("gives another member the item without telemetry, raw triage or the author's email", () => {
    const dto = toFeedbackDto(row, { userId: "someone-else", isStaff: false }, author);

    for (const k of SENSITIVE) expect(dto).not.toHaveProperty(k);
    expect(dto.authorName).toBe("Ada");
    // The derived decision is still there: that is what the board shows.
    expect(dto.intake?.state).toBe("held");
  });

  it("gives the author their own email back, but still no telemetry or triage", () => {
    const dto = toFeedbackDto(row, { userId: AUTHOR, isStaff: false }, author);

    expect(dto.authorEmail).toBe("ada@example.com");
    expect(dto).not.toHaveProperty("telemetry");
    expect(dto).not.toHaveProperty("triage");
    expect(dto.isMine).toBe(true);
  });

  it("gives staff (ORG_UPDATE) the telemetry, raw triage and email", () => {
    const dto = toFeedbackDto(row, { userId: "admin", isStaff: true }, author);

    expect(dto.telemetry).toEqual(row.telemetry);
    expect(dto.triage).toEqual(row.triage);
    expect(dto.authorEmail).toBe("ada@example.com");
  });

  it("never passes through a column it does not name", () => {
    const withExtra = { ...row, internalNote: "secret" } as unknown as FeedbackRow;
    const dto = toFeedbackDto(withExtra, { userId: "admin", isStaff: true }, author);

    expect(dto).not.toHaveProperty("internalNote");
  });

  describe("intake", () => {
    it("gives another member only the outcome: no judge reasoning, score or categories", () => {
      const { intake } = toFeedbackDto(row, { userId: "someone-else", isStaff: false }, author);

      expect(intake).toEqual({ state: "held", label: "Held for review", score: null });
    });

    it("tells the author what happened in a fixed sentence, never the judge's words", () => {
      const { intake } = toFeedbackDto(row, { userId: AUTHOR, isStaff: false }, author);

      expect(intake?.state).toBe("held");
      expect(intake?.score).toBeNull();
      expect(intake?.reason).toBeTruthy();
      expect(intake?.reason).not.toContain("prompt injection");
      expect(intake).not.toHaveProperty("categories");
    });

    it("gives staff the full decision, score and reasoning included", () => {
      const { intake } = toFeedbackDto(row, { userId: "admin", isStaff: true }, author);

      expect(intake).toMatchObject({ state: "held", score: 0.8 });
      expect(intake?.reason).toContain("prompt injection");
    });
  });
});

