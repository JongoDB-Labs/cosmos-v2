import { describe, it, expect } from "vitest";
import { mergeDependencies } from "./merge-deps.mjs";

const core = { next: "16.0.0", react: "19.0.0" };

describe("mergeDependencies", () => {
  it("returns core untouched when no plugin declares dependencies", () => {
    expect(mergeDependencies(core, [{ slug: "a", dependencies: undefined }])).toEqual(core);
  });

  it("adds a plugin dependency", () => {
    const out = mergeDependencies(core, [
      { slug: "pi-planning", dependencies: { yjs: "^13.6.27" } },
    ]);
    expect(out.yjs).toBe("^13.6.27");
    expect(out.next).toBe("16.0.0");
  });

  it("allows two plugins to declare the identical range", () => {
    const out = mergeDependencies(core, [
      { slug: "a", dependencies: { yjs: "^13.6.27" } },
      { slug: "b", dependencies: { yjs: "^13.6.27" } },
    ]);
    expect(out.yjs).toBe("^13.6.27");
  });

  it("throws naming both plugins when two want different ranges", () => {
    expect(() =>
      mergeDependencies(core, [
        { slug: "a", dependencies: { yjs: "^13.6.27" } },
        { slug: "b", dependencies: { yjs: "^14.0.0" } },
      ]),
    ).toThrow(/yjs.*a wants \^13\.6\.27.*b wants \^14\.0\.0/s);
  });

  it("throws when a plugin conflicts with a core dependency", () => {
    expect(() =>
      mergeDependencies(core, [{ slug: "a", dependencies: { react: "18.0.0" } }]),
    ).toThrow(/react.*conflicts with core/s);
  });

  it("returns keys sorted so the package.json diff is stable", () => {
    const out = mergeDependencies(core, [
      { slug: "a", dependencies: { aaa: "1.0.0", zzz: "1.0.0" } },
    ]);
    expect(Object.keys(out)).toEqual(["aaa", "next", "react", "zzz"]);
  });

  it("does not mutate the caller's core dependency map", () => {
    const original = { ...core };
    mergeDependencies(core, [{ slug: "a", dependencies: { yjs: "^13.6.27" } }]);
    expect(core).toEqual(original);
  });
});
