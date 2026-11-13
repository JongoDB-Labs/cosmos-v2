// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PUBLIC_HANDLERS, SIGNED_OUT_STEPS, signedOutMayReach } from "./signed-out-api";

describe("signedOutMayReach: the API handlers a caller with no session reaches", () => {
  it.each([
    ["POST", "/api/auth/account-request"],
    ["GET", "/api/orgs/acme/brand"],
    ["GET", "/api/health"],
    ["GET", "/api/v1/calendar/feeds/abc123.ics"],
    ["GET", "/api/auth/sso/acme/status"],
    ["POST", "/api/auth/password/mfa"],
    // A plugin's handler, listed with its route group, is reached at the URL the group leaves out.
    ["POST", "/api/foreman/alert"],
  ])("lets %s %s through", (method, path) => {
    expect(signedOutMayReach(method, path)).toBe(true);
  });

  it.each([
    // A listed path, with a method that isn't listed.
    ["GET", "/api/auth/account-request"],
    ["POST", "/api/orgs/acme/brand"],
    ["DELETE", "/api/v1/calendar/feeds/abc123.ics"],
    // A neighbour of a listed path: longer, shorter, or sharing its prefix.
    ["GET", "/api/orgs/acme/brand/extra"],
    ["GET", "/api/orgs/acme/brandx"],
    ["GET", "/api/orgs/a/b/brand"],
    ["GET", "/api/orgs/acme"],
    ["GET", "/api/healthz"],
    ["GET", "/api/v1/calendar/feeds"],
    ["POST", "/api/auth/account-request/x"],
    // Anything not listed.
    ["GET", "/api/v1/orgs/x/projects"],
    ["POST", "/api/auth/password/change"],
  ])("refuses %s %s", (method, path) => {
    expect(signedOutMayReach(method, path)).toBe(false);
  });

  it("treats HEAD as the GET it is answered by, and OPTIONS as a question about a listed path", () => {
    expect(signedOutMayReach("HEAD", "/api/health")).toBe(true);
    expect(signedOutMayReach("HEAD", "/api/auth/account-request")).toBe(false);
    expect(signedOutMayReach("OPTIONS", "/api/auth/account-request")).toBe(true);
    expect(signedOutMayReach("OPTIONS", "/api/v1/orgs/x/projects")).toBe(false);
  });

  it("reads every entry as `<METHOD> <route path>`", () => {
    for (const key of [...Object.keys(PUBLIC_HANDLERS), ...Object.keys(SIGNED_OUT_STEPS)]) {
      expect(key).toMatch(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) [^\s/][^\s]*[^\s/]$/);
    }
  });
});
