import { describe, it, expect } from "vitest";
import { projectKeyFromRoute } from "./route-project";

describe("projectKeyFromRoute", () => {
  it("extracts the key after /projects/", () => {
    expect(projectKeyFromRoute("/defcon-new/projects/VITL/pm-dashboard")).toBe("VITL");
    expect(projectKeyFromRoute("/fsc/projects/COSMOS")).toBe("COSMOS");
  });
  it("returns null when there is no project segment", () => {
    expect(projectKeyFromRoute("/settings/ai")).toBeNull();
    expect(projectKeyFromRoute("/")).toBeNull();
    expect(projectKeyFromRoute(undefined)).toBeNull();
  });
  it("ignores query/hash and trailing slashes", () => {
    expect(projectKeyFromRoute("/o/projects/APEX/?tab=1#x")).toBe("APEX");
  });
});
