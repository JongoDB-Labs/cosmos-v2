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

/**
 * The tier used to be chosen from the declared type alone. Browsers send no type at
 * all for a great many ordinary files, so every .log, .yml and .py landed in the
 * download tier — the wrong answer for a library people read out of. These are about
 * the filename fallback staying a NARROWING: it may pick a tier, never widen one.
 */
describe("serveHeaders — the long tail", () => {
  it("plays video and audio in the page rather than downloading them", () => {
    for (const [ct, name] of [["video/mp4", "walkthrough.mp4"], ["video/webm", "a.webm"], ["audio/mpeg", "call.mp3"], ["audio/wav", "a.wav"]] as const) {
      const h = serveHeaders(ct, name);
      expect(h.get("Content-Type")).toBe(ct);
      expect(h.get("Content-Disposition")).toMatch(/^inline/);
      expect(h.get("Content-Security-Policy")).toBeNull();
    }
  });

  it("reads the filename when the browser sent no type, which is the common case", () => {
    for (const name of ["server.log", "values.yml", "migrate.sql", "report.py", "notes.txt"]) {
      expect(serveHeaders("", name).get("Content-Type")).toBe("text/plain; charset=utf-8");
    }
    expect(serveHeaders("", "site.png").get("Content-Type")).toBe("image/png");
    expect(serveHeaders(null, "clip.mp4").get("Content-Type")).toBe("video/mp4");
  });

  it("treats an unlisted text/* subtype as words, because the type is rewritten anyway", () => {
    for (const ct of ["text/x-python", "text/yaml", "text/css", "text/javascript"]) {
      expect(serveHeaders(ct, "f").get("Content-Type")).toBe("text/plain; charset=utf-8");
    }
  });

  it("will not let the filename promote a scripting document out of the sandbox", () => {
    for (const [ct, name] of [["", "saved.html"], ["application/octet-stream", "logo.svg"], [null, "feed.xml"]] as const) {
      expect(serveHeaders(ct, name).get("Content-Security-Policy")).toBe("sandbox");
    }
  });

  it("lets a recognised declared type beat the extension, in both directions", () => {
    // claims to be a page, named like a picture: still sandboxed, never an image
    expect(serveHeaders("text/html", "harmless.png").get("Content-Security-Policy")).toBe("sandbox");
    // claims to be a picture, named like a page: served as the picture, with nosniff
    const h = serveHeaders("image/png", "evil.html");
    expect(h.get("Content-Type")).toBe("image/png");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not rescue an extension it has no entry for", () => {
    for (const name of ["plan.dwg", "model.rvt", "setup.exe", "lib.so", "archive.zip"]) {
      const h = serveHeaders("", name);
      expect(h.get("Content-Type")).toBe("application/octet-stream");
      expect(h.get("Content-Disposition")).toMatch(/^attachment/);
    }
  });

  it("is not confused by case, a dotfile, or no extension at all", () => {
    expect(serveHeaders("", "NOTES.MD").get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(serveHeaders("", "README").get("Content-Disposition")).toMatch(/^attachment/);
    // a leading dot is the whole name, not an extension
    expect(serveHeaders("", ".gitignore").get("Content-Disposition")).toMatch(/^attachment/);
  });
});

describe("renderModeFor — the long tail", () => {
  it("tells the client to use a player, and reads the filename like the headers do", () => {
    expect(renderModeFor("video/mp4", "a.mp4")).toBe("video");
    expect(renderModeFor("audio/mpeg", "a.mp3")).toBe("audio");
    expect(renderModeFor("", "server.log")).toBe("text");
    expect(renderModeFor("", "saved.html")).toBe("sandboxed");
    expect(renderModeFor("", "plan.dwg")).toBe("download");
  });
});
