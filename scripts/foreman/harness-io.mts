// IO side of the Foreman build harness (the pure decisions live in
// src/lib/foreman/harness.ts). Fetches the skills/MCP/settings applicable to an org
// and materializes skills into the ephemeral build worktree so settingSources:
// ["project"] picks them up. A per-build harness failure must never block a build.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { unsealMcpJson } from "@/lib/integrations/mcp-secrets";
import { skillDirName, type HarnessMcpServer } from "@/lib/foreman/harness";

export interface LoadedHarness {
  settings: { enabled: boolean; systemPromptAppend: string | null } | null;
  skills: { name: string; body: string }[];
  servers: HarnessMcpServer[];
}

/** Fetch the skills / http MCP servers / settings applicable to `orgId` (project-wide
 *  rows with orgId NULL + this org's rows, enabled only); unseal MCP headers. */
export async function loadHarness(orgId: string): Promise<LoadedHarness> {
  const [settings, skillRows, serverRows] = await Promise.all([
    prisma.foremanHarnessSettings.findUnique({
      where: { orgId },
      select: { enabled: true, systemPromptAppend: true },
    }),
    prisma.foremanSkill.findMany({
      where: { OR: [{ orgId: null }, { orgId }], enabled: true },
      select: { name: true, body: true },
    }),
    prisma.foremanMcpServer.findMany({
      where: { OR: [{ orgId: null }, { orgId }], enabled: true },
      select: { name: true, url: true, headers: true },
    }),
  ]);
  const servers: HarnessMcpServer[] = serverRows.map((r) => ({
    name: r.name,
    url: r.url,
    headers: r.headers ? unsealMcpJson(r.headers as string) : null,
  }));
  return { settings, skills: skillRows, servers };
}

/** Write each skill to <worktreeDir>/.claude/skills/<slug>/SKILL.md. Best-effort:
 *  a write failure is logged-by-omission and never throws (never blocks a build). */
export async function materializeSkills(
  worktreeDir: string,
  skills: { name: string; body: string }[],
): Promise<void> {
  for (const s of skills) {
    try {
      const dir = join(worktreeDir, ".claude", "skills", skillDirName(s.name));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), s.body, "utf8");
    } catch {
      // best-effort — never block a build on a skill write
    }
  }
}
