// @vitest-environment node
//
// connect-src and the realtime sidecars.
//
// A sidecar pointed at another host had its WebSocket refused by CSP. The board
// still rendered (realtime is best-effort by design), so the only evidence was a
// console line nobody watches — collaboration silently off.
//
// The tempting fix is a blanket `ws: wss:`. These tests exist mainly to stop
// that: on a CUI-adjacent deployment it would permit a socket to ANY host, i.e.
// trade a narrow configuration problem for a broad exfiltration path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL = { ...process.env };

async function cspFor(env: Record<string, string | undefined>): Promise<string> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // The header is built at module load, so the module must be re-evaluated for
  // each env permutation — otherwise every case would read the first one's value.
  vi.resetModules();
  const { applySecurityHeaders } = await import("./headers");
  const h = new Headers();
  applySecurityHeaders(h);
  return h.get("Content-Security-Policy") ?? "";
}

function frameSrc(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src")) ?? "";
}

function connectSrc(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src")) ?? "";
}

beforeEach(() => {
  delete process.env.WHITEBOARD_REALTIME_URL;
  delete process.env.PI_PLANNING_REALTIME_URL;
  delete process.env.PROGRAM_MANAGEMENT_EMBED_URL;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("CSP connect-src", () => {
  it("NEVER allows a blanket ws:/wss: — that would permit any host", async () => {
    const c = connectSrc(await cspFor({ WHITEBOARD_REALTIME_URL: "wss://boards.example.com/rt" }));
    expect(c).not.toMatch(/(^|\s)wss:(\s|$)/);
    expect(c).not.toMatch(/(^|\s)ws:(\s|$)/);
  });

  it("names a configured cross-origin sidecar, by ORIGIN not path", async () => {
    const c = connectSrc(await cspFor({ WHITEBOARD_REALTIME_URL: "wss://boards.example.com/whiteboard/realtime" }));
    expect(c).toContain("wss://boards.example.com");
    // A CSP source is host-scoped; a path would be meaningless and misleading.
    expect(c).not.toContain("/whiteboard/realtime");
  });

  it("adds nothing when no sidecar is configured", async () => {
    const c = connectSrc(await cspFor({}));
    expect(c).toContain("'self'");
    expect(c).not.toContain("example.com");
  });

  it("carries both sidecars, deduped when they share an origin", async () => {
    const c = connectSrc(await cspFor({
      WHITEBOARD_REALTIME_URL: "wss://rt.example.com/whiteboard/realtime",
      PI_PLANNING_REALTIME_URL: "wss://rt.example.com/pi-planning/realtime",
    }));
    expect(c.match(/wss:\/\/rt\.example\.com/g)?.length).toBe(1);
  });

  it("survives a malformed URL instead of taking the whole header down", async () => {
    // A broken env var must not blank the CSP for every request — the feature it
    // belongs to fails loudly on its own.
    const c = connectSrc(await cspFor({
      WHITEBOARD_REALTIME_URL: "not a url",
      PI_PLANNING_REALTIME_URL: "wss://ok.example.com/rt",
    }));
    expect(c).toContain("'self'");
    expect(c).toContain("wss://ok.example.com");
  });

  it("keeps the origins it already needed", async () => {
    const c = connectSrc(await cspFor({}));
    expect(c).toContain("https://accounts.google.com");
    expect(c).toContain("https://www.googleapis.com");
  });
});

// frame-src and the outside dashboard Program Management can frame
// (src/lib/pm/embed.ts). The page and the CSP read the same setting; if they
// disagreed, the page would render a frame the browser refuses -- an empty box.
describe("CSP frame-src", () => {
  it("names the configured dashboard, by ORIGIN not path", async () => {
    const f = frameSrc(await cspFor({ PROGRAM_MANAGEMENT_EMBED_URL: "https://pm.example.com/board?x=1" }));
    expect(f).toContain("https://pm.example.com");
    expect(f).not.toContain("/board");
    // What it already allowed is still there.
    expect(f).toContain("'self'");
    expect(f).toContain("https://accounts.google.com");
  });

  it("adds nothing when unset", async () => {
    const f = frameSrc(await cspFor({}));
    expect(f).toBe("frame-src 'self' https://accounts.google.com");
  });

  it("adds nothing for a URL the page itself would refuse", async () => {
    // Plain http to a real host: the page falls back to the built-in view,
    // so the CSP must not widen for it either.
    const f = frameSrc(await cspFor({ PROGRAM_MANAGEMENT_EMBED_URL: "http://pm.example.com/" }));
    expect(f).toBe("frame-src 'self' https://accounts.google.com");
  });

  it("never lets Cosmos itself be framed because of it", async () => {
    const csp = await cspFor({ PROGRAM_MANAGEMENT_EMBED_URL: "https://pm.example.com/" });
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
