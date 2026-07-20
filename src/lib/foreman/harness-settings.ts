// Per-org settings for the Foreman build harness (skills + project system
// prompt + project MCP tools loaded into every build agent). Absent row ⇒ the
// safe default (enabled, no append). No secrets — plain config.
import { prisma } from "@/lib/db/client";

export interface HarnessSettings {
  enabled: boolean;
  systemPromptAppend: string | null;
}

/** Per-org harness settings, or the defaults (enabled, no append) when unset. */
export async function getForemanHarnessSettings(orgId: string): Promise<HarnessSettings> {
  const row = await prisma.foremanHarnessSettings.findUnique({
    where: { orgId },
    select: { enabled: true, systemPromptAppend: true },
  });
  return row
    ? { enabled: row.enabled, systemPromptAppend: row.systemPromptAppend }
    : { enabled: true, systemPromptAppend: null };
}
