// In-process project MCP tools for Foreman build agents (server key "cosmos"). Built
// per build so the file-reading tools see THIS build's worktree, and ticket_context
// sees the org. These give the agent info it can't easily get (DB context) or a
// reliable structured read (schema, changelog invariant). Code-defined only — never
// user-supplied (an in-process tool runs in the daemon).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prisma } from "@/lib/db/client";

function txt(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** The "cosmos" in-process MCP server for one build (worktree + org scoped). */
export function buildProjectMcpServer(worktreeDir: string, orgId: string) {
  return createSdkMcpServer({
    name: "cosmos",
    tools: [
      tool(
        "changelog_check",
        "Check the release invariant: CHANGELOG[0].version must equal package.json version. Returns OK or the exact mismatch.",
        {},
        async () => {
          try {
            const pkg = JSON.parse(await readFile(join(worktreeDir, "package.json"), "utf8")) as { version?: string };
            const cl = await readFile(join(worktreeDir, "src/lib/changelog.ts"), "utf8");
            const after = cl.slice(cl.indexOf("CHANGELOG: Release[] = ["));
            const top = after.match(/version:\s*"([^"]+)"/)?.[1] ?? "(none)";
            return txt(
              pkg.version === top
                ? `OK: package.json and CHANGELOG[0] are both ${pkg.version}.`
                : `MISMATCH: package.json=${pkg.version} but CHANGELOG[0]=${top}. Prepend a matching CHANGELOG entry.`,
            );
          } catch (e) {
            return txt(`could not check changelog: ${String(e)}`);
          }
        },
      ),
      tool(
        "schema_models",
        "List the Prisma models and their fields from prisma/schema.prisma so you don't have to guess the schema.",
        {},
        async () => {
          try {
            const s = await readFile(join(worktreeDir, "prisma/schema.prisma"), "utf8");
            const models = [...s.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)].map((mm) => {
              const fields = [...mm[2].matchAll(/^\s*(\w+)\s+([\w[\]?.]+)/gm)]
                .map((f) => `${f[1]}:${f[2]}`)
                .slice(0, 40);
              return `${mm[1]}(${fields.join(", ")})`;
            });
            return txt(models.join("\n") || "(no models found)");
          } catch (e) {
            return txt(`could not read schema: ${String(e)}`);
          }
        },
      ),
      tool(
        "ticket_context",
        "Get a work item's title, board column, and description by its ticket key (e.g. COSMOS-42).",
        { ticketKey: z.string() },
        async (args) => {
          try {
            const key = String((args as { ticketKey: string }).ticketKey).trim();
            const m = key.match(/^([A-Za-z][\w]*)-(\d+)$/);
            if (!m) return txt(`not a ticket key (expected PREFIX-NUMBER): ${key}`);
            const project = await prisma.project.findFirst({
              where: { orgId, key: m[1].toUpperCase() },
              select: { id: true },
            });
            if (!project) return txt(`no project "${m[1]}" in this org`);
            const item = await prisma.workItem.findFirst({
              where: { orgId, projectId: project.id, ticketNumber: Number(m[2]) },
              select: { title: true, columnKey: true, description: true },
            });
            if (!item) return txt(`no work item found for ${key}`);
            return txt(`${key}: "${item.title}" · column=${item.columnKey}\n${(item.description ?? "").slice(0, 800)}`);
          } catch (e) {
            return txt(`could not fetch ticket: ${String(e)}`);
          }
        },
      ),
    ],
  });
}
