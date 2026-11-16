// @vitest-environment node
//
// The client error sink writes the page URL to the server log. A page URL can
// carry a credential in its query string, as an emailed reset link does, so the
// log keeps the page and drops the query string and fragment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const report = (url: string) =>
  POST(
    new NextRequest("http://localhost:3000/api/v1/metrics/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "boom", url }),
    }),
  );

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(" ");
}

describe("client error sink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the page without its query string or fragment", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await report("https://cosmos.example/some/page?token=SECRET-QUERY&x=1#SECRET-FRAGMENT");
    expect(res.status).toBe(200);
    const text = logged(spy);
    expect(text).toContain("url=https://cosmos.example/some/page msg=boom");
    expect(text).not.toContain("SECRET-QUERY");
    expect(text).not.toContain("SECRET-FRAGMENT");
  });

  it("drops the same from a URL that doesn't parse", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await report("/some/page#SECRET-FRAGMENT?token=SECRET-QUERY");
    const text = logged(spy);
    expect(text).toContain("url=/some/page msg=boom");
    expect(text).not.toMatch(/SECRET/);
  });
});
