import { describe, it, expect } from "vitest";
import { slotContributions } from "../plugin-slot";
import { PLUGIN_API_VERSION, type PluginManifest } from "@/lib/plugins/registry";
import { Blocks } from "lucide-react";

const Card = () => null; // stand-in slot component

function manifest(slug: string, withSlot: boolean): PluginManifest {
  return {
    apiVersion: PLUGIN_API_VERSION,
    slug,
    name: slug,
    description: "",
    icon: Blocks,
    version: "1.0.0",
    modules: [],
    ...(withSlot ? { slots: { "overview.card": Card } } : {}),
  };
}

describe("plugin slot selection (fail-closed)", () => {
  const withSlot = manifest("foo", true);
  const noSlot = manifest("bar", false);

  it("renders nothing when the registry is empty", () => {
    expect(slotContributions("overview.card", [], new Set(["foo"]))).toEqual([]);
  });

  it("does NOT render a slot whose plugin is not enabled (fail-closed)", () => {
    expect(slotContributions("overview.card", [withSlot], new Set())).toEqual([]);
    expect(slotContributions("overview.card", [withSlot], new Set(["other"]))).toEqual([]);
  });

  it("renders an enabled plugin's slot component", () => {
    const out = slotContributions("overview.card", [withSlot], new Set(["foo"]));
    expect(out.map((c) => c.slug)).toEqual(["foo"]);
    expect(out[0].Comp).toBe(Card);
  });

  it("ignores enabled plugins that don't contribute the slot", () => {
    expect(slotContributions("overview.card", [noSlot], new Set(["bar"]))).toEqual([]);
    expect(slotContributions("workItem.detailBadge", [withSlot], new Set(["foo"]))).toEqual([]);
  });
});
