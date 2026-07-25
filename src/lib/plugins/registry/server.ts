import "./index"; // manifests register first

/**
 * SERVER-ONLY plugin composition point — the second sanctioned shared→plugin
 * import (see registry/index.ts). Server modules (API routes, agent loop,
 * provisioning) side-effect import THIS file so seed hooks / AI tools /
 * integration adapters never enter a client bundle. The PUBLIC core registers
 * NO server hooks — this is the empty seam.
 *
 * A private plugin repo composes itself in at build time by adding, here:
 *   import { PluginServerRegistry } from "../registry";
 *   import { IntegrationRegistry } from "@/lib/integrations/registry";
 *   import { fooServerHooks } from "@/plugins/foo/server";
 *   PluginServerRegistry.register(fooServerHooks);
 *   for (const p of fooServerHooks.integrations ?? []) IntegrationRegistry.register(p);
 */

export {};
