// @vitest-environment node
//
// `next build` collects page data and generates static pages in worker
// processes, each loading the whole server bundle. Next's default count is one
// per CPU less one, counted on the host rather than on the build's own share of
// it, so a large CI host ran 39. Measured on this app (2026-11-16): 39 workers
// peaked at 9.7 GB for the build, 8 at 4.0 GB, and 8 were no slower. Next to the
// CI job's own type check, 39 crossed the job's memory limit and the type check
// was killed. The cap lives in next.config.ts.
import { describe, expect, it } from "vitest";
import config from "../../../next.config";

describe("next build workers", () => {
  it("are capped, whatever the host's CPU count", () => {
    const cpus = config.experimental?.cpus;
    expect(typeof cpus).toBe("number");
    expect(cpus).toBeGreaterThanOrEqual(1);
    expect(cpus).toBeLessThanOrEqual(8);
  });
});
