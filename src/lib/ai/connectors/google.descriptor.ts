// src/lib/ai/connectors/google.descriptor.ts
//
// Google Workspace expressed as a ConnectorDescriptor — a pure re-expression of the
// EXISTING wiring (tools/google.ts defs + executors/google.ts dispatch). No tool
// logic is rewritten; the descriptor only references them.
//
// EGRESS — DELIBERATELY EMPTY. Google has NO TOOL_ENTITY mapping in egress today,
// which means every Google tool result has NO structural entity type ⇒ FULL WITHHOLD
// for a gov tenant (the email/doc/event/file/contact bodies are the worst-case CUI).
// The commercial-unclassified case still flows because the gate exposes BEFORE
// projection. Preserve that exactly: `egress: {}` (no entityType for any google tool).

import type { ConnectorDescriptor } from "./types";
import { googleTools } from "../tools/google";
import { executeGoogleTool } from "../executors/google";

export const googleConnector: ConnectorDescriptor = {
  provider: "google",
  toolDefs: googleTools,
  // The registry only dispatches names this descriptor owns; executeGoogleTool
  // resolves every google tool name (returns null only for a non-google name,
  // which the registry never passes here).
  execute: (name, input, ctx) =>
    executeGoogleTool(name, input, { userId: ctx.userId, orgId: ctx.orgId }),
  // No structural entity mapping ⇒ full withhold for gov. (Unchanged from the
  // pre-registry projection.ts, which intentionally omitted every google_* tool.)
  egress: {},
};
