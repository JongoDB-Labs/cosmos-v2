import type { McpServer } from "@prisma/client";
import { sealField, openField } from "@/lib/crypto/field-seal";

/**
 * MCP server secret-at-rest accessors (3.13.16 protect-at-rest; IA-5).
 *
 * An MCP server's `env` (process env for stdio servers — typically API tokens)
 * and `headers` (auth headers for http/sse servers — typically bearer tokens) are
 * SECRET. They are sealed into the `env_enc` / `headers_enc` String columns as
 * vault envelopes of `JSON.stringify(map)` via {@link sealField}, and opened back
 * here via {@link openField} (also re-wrapped on a key rotation — these columns
 * are in scripts/dsop/rotate-vault-key.mjs SEALED_COLUMNS).
 *
 * MCP EXECUTION IS DORMANT (Phase 0 dropped the host-CLI MCP-config flag wiring), so
 * there is no live read path today — the create/update routes seal on write, and
 * these accessors exist for when Phase 4 rewires MCP as native executors. The
 * opened maps are for immediate server-side use (spawning the MCP process / minting
 * the http client); NEVER returned to a client or logged.
 */

/** Seal an env/headers map into its at-rest column value (or null for an empty/absent map). */
export function sealMcpJson(map: Record<string, string> | null | undefined): string | null {
  if (!map || Object.keys(map).length === 0) return null;
  return sealField(JSON.stringify(map));
}

/** Open a sealed env/headers column back to its map; null/empty → `{}`. Transparent to legacy plaintext. */
function openMcpJson(stored: string | null): Record<string, string> {
  if (!stored) return {};
  const parsed: unknown = JSON.parse(openField(stored));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Public unseal of a sealMcpJson string → the header/env map (or {} when null). */
export function unsealMcpJson(stored: string | null): Record<string, string> {
  return openMcpJson(stored);
}

/** The MCP server's process env map, opened from `env_enc` (or `{}` if unset). */
export function getMcpEnv(server: Pick<McpServer, "envEnc">): Record<string, string> {
  return openMcpJson(server.envEnc);
}

/** The MCP server's auth headers map, opened from `headers_enc` (or `{}` if unset). */
export function getMcpHeaders(server: Pick<McpServer, "headersEnc">): Record<string, string> {
  return openMcpJson(server.headersEnc);
}
