// @vitest-environment node
import { describe, it, expect } from "vitest";
import { assembleHarnessOptions } from "./harness";

const base = () => ({
  enabled: true,
  baseAllowedTools: ["Read", "Grep", "Edit", "Write", "Bash"],
  basePermissionMode: "acceptEdits" as const,
  skills: [{ name: "cosmos-testing" }, { name: "cosmos-architecture" }],
  mcpServers: [{ name: "docs", url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } }],
  systemPromptAppend: "Follow cosmos conventions.",
  foremanBrief: "Build ticket COSMOS-1.",
});

describe("assembleHarnessOptions", () => {
  it("adds skills, the Skill tool, and mcp__* to allowedTools WITHOUT dropping the base tools", () => {
    const o = assembleHarnessOptions(base());
    for (const t of ["Read", "Grep", "Edit", "Write", "Bash"]) expect(o.allowedTools).toContain(t);
    expect(o.allowedTools).toContain("Skill");
    expect(o.allowedTools).toContain("mcp__docs");
    expect(o.settingSources).toEqual(["project"]);
    expect(o.skills).toBe("all");
  });
  it("never loosens permissionMode (returns the base unchanged)", () => {
    expect(assembleHarnessOptions(base()).permissionMode).toBe("acceptEdits");
  });
  it("composes systemPrompt as preset+append including the brief and the org append", () => {
    const o = assembleHarnessOptions(base());
    expect(o.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(o.systemPrompt.append).toContain("Build ticket COSMOS-1.");
    expect(o.systemPrompt.append).toContain("Follow cosmos conventions.");
  });
  it("filters out non-http MCP servers (defense in depth)", () => {
    const o = assembleHarnessOptions({ ...base(), mcpServers: [{ name: "bad", url: "stdio:///bin/sh", headers: null }] });
    expect(o.mcpServers).toEqual({});
    expect(o.allowedTools).not.toContain("mcp__bad");
  });
  it("disabled => an empty fragment that changes nothing", () => {
    const o = assembleHarnessOptions({ ...base(), enabled: false });
    expect(o.settingSources).toBeUndefined();
    expect(o.mcpServers).toEqual({});
    expect(o.allowedTools).toEqual(["Read", "Grep", "Edit", "Write", "Bash"]);
  });
});
