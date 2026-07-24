/**
 * Foreman server-boot registrations (interim, P1.5).
 *
 * Foreman still lives in-tree, but core no longer imports its internals directly.
 * This module is the ONE intentional, clearly-labeled core→Foreman edge: loaded once
 * at server startup (instrumentation.ts `register()`), it registers Foreman's
 * server-side contributions into the neutral core registries.
 *
 * When Foreman becomes a plugin (P3) this file is DELETED — its registrations move
 * into the Foreman plugin's PluginServerHooks, loaded through the neutral plugin
 * composition seam (src/lib/plugins/registry/server.ts). Core keeps only the
 * registry + resolve APIs.
 */

import { registerModelCredentialProvider } from "@/lib/ai/model-credential-provider";
import { getForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";

// The feedback-intake judges resolve their model credential through this provider.
// Fail-safe: if this registration never runs (Foreman absent), resolveModelCredential
// returns null and the judges degrade gracefully.
registerModelCredentialProvider(getForemanClaudeCreds);
