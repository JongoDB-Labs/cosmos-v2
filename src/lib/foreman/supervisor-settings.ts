// Per-org settings for the Foreman supervisor (src/lib/foreman/supervisor.ts is
// the pure decision core; this reads the DB config the console writes). Absent row
// ⇒ the safe defaults (mode "dry"). No secrets — plain config.
import { prisma } from "@/lib/db/client";
import { DEFAULT_CONFIG, type SupervisorConfig } from "./supervisor";

export type SupervisorMode = "off" | "dry" | "live";

export interface SupervisorSettings extends SupervisorConfig {
  mode: SupervisorMode;
}

function coerceMode(raw: string): SupervisorMode {
  return raw === "off" || raw === "live" ? raw : "dry";
}

/** The org's supervisor settings, or the safe defaults (DEFAULT_CONFIG + mode
 *  "dry") when no row exists. DEFAULT_CONFIG is the single source of the numeric
 *  defaults so the daemon and the UI never drift. */
export async function getForemanSupervisorSettings(orgId: string): Promise<SupervisorSettings> {
  const row = await prisma.foremanSupervisorSettings.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_CONFIG, mode: "dry" };
  return {
    mode: coerceMode(row.mode),
    deliverClose: row.deliverClose,
    requeue: row.requeue,
    dedup: row.dedup,
    escalate: row.escalate,
    confidenceThreshold: row.confidenceThreshold,
    perPassCap: row.perPassCap,
  };
}
