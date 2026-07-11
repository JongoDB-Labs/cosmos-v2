import { describe, it, expect } from "vitest";
import { buildCloseWordRegex, matchCloseWord, DEFAULT_CLOSE_WORD } from "./close-word";

describe("buildCloseWordRegex + matchCloseWord", () => {
  const send = buildCloseWordRegex(DEFAULT_CLOSE_WORD);

  it("matches the default phrase at the end, with recognizer punctuation", () => {
    expect(matchCloseWord("create a ticket for the login bug send it", send)).toBe("create a ticket for the login bug");
    expect(matchCloseWord("create a ticket, send it.", send)).toBe("create a ticket");
    expect(matchCloseWord("Create a ticket Send It!", send)).toBe("Create a ticket");
  });

  it("does not match mid-sentence or unrelated text", () => {
    expect(matchCloseWord("send it to the backlog tomorrow", send)).toBeNull();
    expect(matchCloseWord("please resend it", send)).toBeNull(); // 'resend' ≠ 'send'...
  });

  it("a bare close word yields an empty message (caller skips the send)", () => {
    expect(matchCloseWord("send it", send)).toBe("");
  });

  it("custom phrases work, with flexible whitespace between words", () => {
    const r = buildCloseWordRegex("over and out");
    expect(matchCloseWord("deploy the fix over  and   out", r)).toBe("deploy the fix");
    expect(matchCloseWord("over and out", r)).toBe("");
  });

  it("regex metacharacters in a custom phrase are escaped, not interpreted", () => {
    const r = buildCloseWordRegex("done (send)");
    expect(matchCloseWord("summarize this done (send)", r)).toBe("summarize this");
    expect(matchCloseWord("summarize this done send", r)).toBeNull();
  });

  it("blank/null phrases fall back to the default", () => {
    for (const p of ["", "   ", null, undefined]) {
      const r = buildCloseWordRegex(p);
      expect(matchCloseWord("hello there send it", r)).toBe("hello there");
    }
  });
});
