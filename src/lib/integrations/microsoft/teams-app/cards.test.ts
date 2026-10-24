// COSMOS-202 T1: a Teams message becomes a work item's description as plain
// text. Nothing tag-shaped survives, however it is encoded or nested.
import { describe, it, expect } from "vitest";
import { messageText } from "./cards";

const TAG = /<[^<>]*>/;

describe("messageText", () => {
  it("keeps the words and the line breaks, and decodes entities", () => {
    expect(messageText("<p>Login loops</p><p>3 customers &amp; me &lt;3</p>")).toBe("Login loops\n3 customers & me <3");
    expect(messageText("a<br>b<br/>c")).toBe("a\nb\nc");
    expect(messageText("caf&#233; &#x2603; &nbsp;x")).toBe("café ☃  x");
  });

  it("decodes once, so an escaped entity stays text", () => {
    expect(messageText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves no tag that entities were hiding", () => {
    const out = messageText("<p>&lt;img src=x onerror=alert(1)&gt;hi</p>");
    expect(out).toBe("hi");
    expect(out).not.toMatch(TAG);
  });

  it("leaves no tag that stripping would join back together", () => {
    for (const input of ["<scr<script>ipt>alert(1)</scr</script>ipt>", "&lt;scr&lt;script&gt;ipt&gt;alert(1)", "<<b>img src=x onerror=y>>"]) {
      const out = messageText(input);
      expect(out, input).not.toMatch(TAG);
      expect(out, input).not.toMatch(/<\s*(script|img)/i);
    }
  });
});
