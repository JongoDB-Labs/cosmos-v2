import { describe, it, expect } from "vitest";
import { serveHeaders, renderModeFor } from "../serve";

/**
 * A Document's contentType is whatever the UPLOADER claimed. These tests are
 * about not trusting it: before this existed, the only thing preventing stored
 * XSS was an upload gate that refused anything without a parser, and widening
 * what may be STORED is what made what may be RENDERED a separate question.
 */
describe("serveHeaders", () => {
  it("renders an image as itself", () => {
    const h = serveHeaders("image/png", "site.png");
    expect(h.get("Content-Type")).toBe("image/png");
    expect(h.get("Content-Disposition")).toMatch(/^inline/);
  });

  it("renders a pdf inline, which is the one rich format a browser can be trusted with", () => {
    expect(serveHeaders("application/pdf", "a.pdf").get("Content-Disposition")).toMatch(/^inline/);
  });

  it("forces textual types to text/plain so a mislabelled payload is characters, not markup", () => {
    for (const ct of ["text/csv", "text/markdown", "application/json"]) {
      expect(serveHeaders(ct, "f").get("Content-Type")).toBe("text/plain; charset=utf-8");
    }
  });

  it("sandboxes html — an opaque origin with no script", () => {
    const h = serveHeaders("text/html", "evil.html");
    expect(h.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("sandboxes SVG, which is a document that can carry <script> and is not an image here", () => {
    expect(serveHeaders("image/svg+xml", "logo.svg").get("Content-Security-Policy")).toBe("sandbox");
  });

  it("downloads anything it does not recognise rather than guessing", () => {
    const h = serveHeaders("application/x-dwg", "plan.dwg");
    expect(h.get("Content-Type")).toBe("application/octet-stream");
    expect(h.get("Content-Disposition")).toMatch(/^attachment/);
  });

  it("always sends nosniff, so a browser cannot promote a .txt to HTML", () => {
    for (const ct of ["image/png", "text/csv", "text/html", "application/zip", null]) {
      expect(serveHeaders(ct, "f").get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("cannot be used to split a header", () => {
    // The property that matters is NO CR AND NO LF: those end a header and start
    // the next one. Stray text surviving inside the quoted filename is harmless,
    // and asserting its absence was testing tidiness rather than safety.
    const h = serveHeaders("image/png", 'a"\r\nX-Injected: 1.png');
    const cd = h.get("Content-Disposition")!;
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).not.toContain('"a"'); // the quote that would close the field early
    expect(h.get("X-Injected" as string)).toBeNull();
  });

  it("ignores a charset the uploader appended", () => {
    expect(serveHeaders("text/html; charset=utf-8", "x.html").get("Content-Security-Policy")).toBe("sandbox");
  });
});

describe("renderModeFor", () => {
  it("agrees with the headers about what may render", () => {
    expect(renderModeFor("image/png")).toBe("image");
    expect(renderModeFor("application/pdf")).toBe("pdf");
    expect(renderModeFor("text/csv")).toBe("text");
    expect(renderModeFor("image/svg+xml")).toBe("sandboxed");
    expect(renderModeFor("application/zip")).toBe("download");
    expect(renderModeFor(null)).toBe("download");
  });
});
