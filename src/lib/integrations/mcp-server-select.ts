import type { Prisma } from "@prisma/client";

/**
 * An MCP server as the API and the settings page send it: never its sealed
 * env or headers (API tokens, auth headers). Those are write-only: a form
 * sets them, and only the server-side runner opens them (mcp-secrets.ts).
 * Every route and page that returns a server selects through this.
 */
export const MCP_SERVER_PUBLIC_SELECT = {
  id: true,
  orgId: true,
  name: true,
  transport: true,
  command: true,
  args: true,
  url: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.McpServerSelect;
