/**
 * CLIENT-SAFE plugin composition point — the ONLY file in shared code (besides
 * registry/server.ts) allowed to import from src/plugins/** (enforced by
 * plugin-isolation.arch.test.ts). The PUBLIC core ships with NO plugins
 * registered: the framework compiles and runs clean with an empty registry
 * (fail-closed — no plugins ⇒ no plugin surfaces).
 *
 * A private plugin repo composes itself in at build time by adding, here:
 *   import { PluginRegistry } from "../registry";
 *   import { fooManifest } from "@/plugins/foo/manifest";
 *   PluginRegistry.register(fooManifest);
 *
 * Side-effect import it wherever manifests are needed, exactly like the
 * integrations catalog:  import "@/lib/plugins/registry/index";
 */

export {};
