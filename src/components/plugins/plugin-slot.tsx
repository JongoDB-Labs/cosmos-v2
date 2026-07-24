"use client";

import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  PluginRegistry,
  type PluginManifest,
  type PluginSlotName,
  type PluginSlotProps,
} from "@/lib/plugins/registry";
import "@/lib/plugins/registry/index"; // side-effect: client-safe manifests registered

/**
 * Plugin UI slots (ADR 0003). Core embeds `<PluginSlot name="overview.card" orgId={id}/>`
 * at named extension points; an ENABLED plugin's manifest.slots[name] renders there.
 * FAIL-CLOSED: a slot with no enabled contributor renders nothing — the same axis as
 * nav (applyPluginEnablement). The public core (zero plugins) renders every slot empty.
 *
 * RSC note: this is a client component, so a SERVER page (e.g. the overview) can embed
 * it directly; enablement + the registry resolve on the client. The plugin's slot
 * component may itself be a client component that self-fetches.
 */

const EnabledPluginsContext = createContext<ReadonlySet<string>>(new Set());

/** Seed the current org's enabled plugin slugs (from the shell's per-org data + the URL). */
export function PluginEnablementProvider({
  orgs,
  children,
}: {
  orgs: { slug: string; enabledPlugins?: string[] }[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const current = orgs.find((o) => o.slug === pathname.split("/")[1]);
  return (
    <EnabledPluginsContext.Provider value={new Set(current?.enabledPlugins ?? [])}>
      {children}
    </EnabledPluginsContext.Provider>
  );
}

/** Pure: the enabled plugins' components for a slot, in registry order. Unit-testable. */
export function slotContributions<K extends PluginSlotName>(
  name: K,
  manifests: PluginManifest[],
  enabled: ReadonlySet<string>,
): { slug: string; Comp: ComponentType<PluginSlotProps[K]> }[] {
  return manifests
    .filter((p) => enabled.has(p.slug) && p.slots?.[name])
    .map((p) => ({ slug: p.slug, Comp: p.slots![name]! as ComponentType<PluginSlotProps[K]> }));
}

export function PluginSlot<K extends PluginSlotName>(
  props: { name: K } & PluginSlotProps[K],
) {
  const { name, ...rest } = props;
  const enabled = useContext(EnabledPluginsContext);
  const contributions = slotContributions(name, PluginRegistry.getAll(), enabled);
  if (contributions.length === 0) return null;
  return (
    <>
      {contributions.map(({ slug, Comp }) => (
        // rest IS PluginSlotProps[K] at runtime; TS can't narrow Omit<…,"name"> for a
        // generic K, so the double-cast is the sanctioned workaround (not a real risk).
        <Comp key={slug} {...(rest as unknown as PluginSlotProps[K])} />
      ))}
    </>
  );
}
