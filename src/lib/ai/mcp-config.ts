import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@/lib/db/client";

/**
 * Phase 5a — MCP (Model Context Protocol) bridge.
 *
 * The Claude CLI accepts `--mcp-config <path>` pointing at a JSON file with
 * the shape Anthropic publishes in their MCP docs:
 *
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } | { "url": "...", "transport": "http" } } }
 *
 * For each chat turn we read the org's enabled `McpServer` rows, write a
 * fresh temp file with that shape, and hand the path to the CLI. The caller
 * is responsible for cleaning the file up after the CLI exits — we expose
 * `cleanupMcpConfig()` for that, and also use it on the pool's process-death
 * path so leaked tempfiles don't pile up.
 */

interface StdioMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpMcpEntry {
  url: string;
  transport: "http" | "sse";
  headers?: Record<string, string>;
}

type McpEntry = StdioMcpEntry | HttpMcpEntry;

interface McpConfigFile {
  mcpServers: Record<string, McpEntry>;
}

/**
 * Build a per-org MCP config file in tmp. Returns the file path, or `null`
 * if the org has no enabled servers (caller should omit `--mcp-config` in
 * that case to avoid the CLI bootstrapping zero servers).
 */
export async function buildMcpConfigForOrg(
  orgId: string,
): Promise<string | null> {
  const servers = await prisma.mcpServer.findMany({
    where: { orgId, enabled: true },
  });
  if (servers.length === 0) return null;

  const entries: Record<string, McpEntry> = {};
  for (const s of servers) {
    // The CLI keys servers by name in the config object. We sanitize to a
    // safe slug since the chat-side display name may contain spaces.
    const key = sanitizeServerKey(s.name) || s.id;
    if (s.transport === "stdio") {
      if (!s.command) continue; // schema enforces this, but be defensive
      const env = isStringRecord(s.env) ? s.env : {};
      entries[key] = {
        command: s.command,
        args: s.args ?? [],
        env,
      };
    } else if (s.transport === "http" || s.transport === "sse") {
      if (!s.url) continue;
      const headers = isStringRecord(s.headers) ? s.headers : {};
      entries[key] = {
        url: s.url,
        transport: s.transport,
        headers,
      };
    }
  }

  // Nothing valid survived the filter.
  if (Object.keys(entries).length === 0) return null;

  const payload: McpConfigFile = { mcpServers: entries };

  const dir = await mkdtemp(path.join(tmpdir(), "cosmos-mcp-"));
  const file = path.join(dir, "mcp.json");
  await writeFile(file, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}

/**
 * Remove a temp config file (and its containing dir). Safe to call with a
 * `null`/missing path — silently no-ops in that case so callers can just
 * `await cleanupMcpConfig(maybePath)` without a guard.
 */
export async function cleanupMcpConfig(filePath: string | null | undefined) {
  if (!filePath) return;
  try {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    /* ignore — tmpfiles are best-effort */
  }
}

function sanitizeServerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}
