// src/lib/ai/connectors/nango.descriptor.ts
//
// Nango (the OSS unified-API / OAuth broker) expressed as a ConnectorDescriptor —
// COMMERCIAL-ONLY connector breadth (~180 providers) via the self-hosted, in-boundary
// Nango stack. Like google/github this descriptor only REFERENCES the existing tool
// defs (tools/nango.ts) + executor (executors/nango.ts); no tool logic is rewritten.
//
// ── D5 GOV-BLOCK ────────────────────────────────────────────────────────────────
// `availability: "commercial-only"` makes the registry exclude every Nango tool from
// a gov tenant's tool list (L1), refuse dispatch for a gov tenant (L2). The executor
// also hard-checks `tenantClass !== "gov"` (L3); the connect route returns 403 for a
// gov org (L4). A gov tenant can NEVER reach Nango by any path.
//
// ── EGRESS — DELIBERATELY EMPTY ─────────────────────────────────────────────────
// Nango tool results have NO per-entity TOOL_ENTITY mapping (like Google). Net effect:
//   - gov:        no entity type ⇒ FULL WITHHOLD (moot — gov is blocked upstream);
//   - commercial: the gate exposes BEFORE projection, so a commercial (below-FOUO)
//                 result flows FULL; the marking-DLP tripwire in the chokepoint still
//                 applies. No new projection entries are needed (commercial-only).
// If a Nango provider is ever PROMOTED to gov, that must be done via a NATIVE adapter
// with an explicit structural egress mapping — NEVER by widening this descriptor.

import type { ConnectorDescriptor } from "./types";
import { nangoTools } from "../tools/nango";
import { executeNangoTool } from "../executors/nango";

export const nangoConnector: ConnectorDescriptor = {
  provider: "nango",
  availability: "commercial-only",
  toolDefs: nangoTools,
  // The registry only dispatches names this descriptor owns; executeNangoTool resolves
  // every nango tool name (returns null only for a non-nango name, which the registry
  // never passes here). ctx carries tenantClass so the executor enforces its L3 check.
  execute: (name, input, ctx) => executeNangoTool(name, input, ctx),
  // No structural entity mapping ⇒ full withhold for gov (blocked anyway); commercial
  // flows full below FOUO (gate exposes before projection). See header.
  egress: {},
};
