// @vitest-environment node
//
// The header has ONE hard requirement: it must be representable in a header
// value. Everything else is about not renaming the user's file.
import { describe, it, expect } from "vitest";
import { contentDisposition } from "./content-disposition";

/** What a header value must satisfy to be sendable: Latin-1, no CR/LF. */
function isLegalHeaderValue(v: string): boolean {
  return /^[\t\x20-\x7E\x80-\xFF]*$/.test(v);
}

// The actual filename from the 500. The space before "AM" is U+202F.
const MAC_SCREENSHOT = "Screenshot 2026-10-29 at 10.28.00 AM.png";

describe("contentDisposition", () => {
  it("the macOS screenshot name produces a LEGAL header", () => {
    // The regression. Before this, the raw name reached the AWS SDK and threw
    // `Invalid character in header content`.
    const v = contentDisposition(MAC_SCREENSHOT);

    expect(isLegalHeaderValue(v)).toBe(true);
    // Control: the input really does contain the offending character, so this
    // spec cannot pass by testing a plain ASCII name.
    expect(MAC_SCREENSHOT).toMatch(/ /);
    expect(isLegalHeaderValue(MAC_SCREENSHOT)).toBe(false);
  });

  it("keeps the REAL name recoverable in filename*", () => {
    const v = contentDisposition(MAC_SCREENSHOT);
    const star = v.match(/filename\*=UTF-8''(.+)$/)?.[1];

    expect(star).toBeDefined();
    expect(decodeURIComponent(star!)).toBe(MAC_SCREENSHOT);
  });

  it("the ASCII fallback is printable and keeps the extension", () => {
    const quoted = contentDisposition(MAC_SCREENSHOT).match(/filename="([^"]*)"/)?.[1];

    expect(quoted).toBe("Screenshot 2026-10-29 at 10.28.00_AM.png");
    // NOT percent-escaped: that was the other half-fix, and it renames the file.
    expect(quoted).not.toContain("%20");
  });

  it("an ordinary ASCII name is passed through unchanged", () => {
    const v = contentDisposition("report.pdf");
    expect(v).toContain('filename="report.pdf"');
    expect(v).toContain("filename*=UTF-8''report.pdf");
  });

  it("escapes the characters that would break out of the quoted string", () => {
    const v = contentDisposition('ev"il\\name.txt');
    const quoted = v.match(/filename="([^"]*)"/)?.[1];
    expect(quoted).toBe("ev_il_name.txt");
    expect(isLegalHeaderValue(v)).toBe(true);
  });

  it("CR/LF cannot reach the header (response splitting)", () => {
    const v = contentDisposition("a\r\nX-Evil: 1.txt");
    expect(v).not.toMatch(/[\r\n]/);
    expect(isLegalHeaderValue(v)).toBe(true);
  });

  it("a name with nothing printable still yields a legal header", () => {
    const v = contentDisposition("  ");
    expect(isLegalHeaderValue(v)).toBe(true);
    expect(v).toMatch(/filename="/);
  });

  it("honours the disposition type", () => {
    expect(contentDisposition("a.csv", "attachment")).toMatch(/^attachment; /);
    expect(contentDisposition("a.csv")).toMatch(/^inline; /);
  });
});
