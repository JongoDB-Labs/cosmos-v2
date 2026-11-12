// @vitest-environment node
//
// AGENTS.md is the repo's engineering rules file, so `next dev` must leave it
// alone. next.config.ts sets `agentRules: false` to stop Next writing its own
// block into it. Since Next 16.4 that setting also makes every `next dev`
// delete whatever sits between Next's two marker comments. AGENTS.md used to
// keep its first section between those markers, so each dev run deleted it.
//
// This runs Next's own removal code, the function `next dev` calls when
// agentRules is false, against a copy of the real file.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RULES_END_MARKER,
  AGENT_RULES_START_MARKER,
  removeAgentRulesFiles,
} from "next/dist/server/lib/generate-agent-files";
import nextConfig from "../../../next.config";

const AGENTS_MD = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");

/** What `next dev` does to a file with this content, and what it leaves. */
function nextDevRemoval(content: string): { action: string; after: string } {
  const dir = mkdtempSync(join(tmpdir(), "agents-md-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), content, "utf8");
    const { agentsMd } = removeAgentRulesFiles(dir);
    return { action: agentsMd, after: readFileSync(join(dir, "AGENTS.md"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("next dev leaves AGENTS.md as committed", () => {
  it("next.config.ts turns Next's agent rules off", () => {
    expect(nextConfig.agentRules).toBe(false);
  });

  it("the removal next dev runs finds nothing to remove in AGENTS.md", () => {
    const { action, after } = nextDevRemoval(AGENTS_MD);
    expect(action).toBe("unchanged");
    expect(after).toBe(AGENTS_MD);
    expect(AGENTS_MD).not.toContain(AGENT_RULES_START_MARKER);
    expect(AGENTS_MD).not.toContain(AGENT_RULES_END_MARKER);
  });

  it("the section Next first wrote is still in AGENTS.md", () => {
    expect(AGENTS_MD).toContain("# This is NOT the Next.js you know");
  });

  it("control: the same removal does delete a section inside the markers", () => {
    // Without this, "unchanged" above could mean the removal never runs at all.
    const marked = `${AGENT_RULES_START_MARKER}\n\n# Rules\n\n${AGENT_RULES_END_MARKER}\n\n# Kept\n`;
    const { action, after } = nextDevRemoval(marked);
    expect(action).toBe("removed");
    expect(after).toBe("# Kept\n");
  });
});
