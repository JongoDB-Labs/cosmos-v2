import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatMoney } from "./pm-dashboard";

// Regression guard for React #418 (COSMOS-1): the PM dashboard is a client
// component that is server-rendered and then hydrated in the browser. Any text
// it renders must be identical on the server (which runs in UTC) and the client
// (which runs in the visitor's local timezone/locale), or hydration fails with
// a "text content does not match" error. Both formatters must therefore be
// pinned — no ambient timezone/locale may leak in.
describe("pm-dashboard formatters are hydration-stable", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("formatDate renders the UTC calendar day regardless of ambient timezone", () => {
    // Midnight UTC is still the previous day in US Pacific — the exact drift
    // that made the server and client disagree and threw #418.
    const iso = "2026-07-15T00:00:00.000Z";

    process.env.TZ = "America/Los_Angeles";
    const pacific = formatDate(iso);
    process.env.TZ = "Asia/Tokyo";
    const tokyo = formatDate(iso);
    process.env.TZ = "UTC";
    const utc = formatDate(iso);

    expect(utc).toBe("Jul 15, 2026");
    expect(pacific).toBe(utc);
    expect(tokyo).toBe(utc);
  });

  it("formatMoney renders a fixed USD string regardless of ambient timezone", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatMoney(1000)).toBe("$1,000");
    process.env.TZ = "UTC";
    expect(formatMoney(1000)).toBe("$1,000");
  });
});
