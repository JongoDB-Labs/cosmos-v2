import { describe, it, expect, afterEach } from "vitest";
import { kindLabel } from "./kind";
import { PluginRegistry, PLUGIN_API_VERSION, type PluginManifest } from "@/lib/plugins/registry";
import { Bell } from "lucide-react";

const fake = (over: Partial<PluginManifest>): PluginManifest => ({
  apiVersion: PLUGIN_API_VERSION,
  slug: "kindtest",
  name: "Kind test",
  description: "",
  icon: Bell,
  version: "1.0.0",
  modules: [],
  ...over,
});

describe("kindLabel", () => {
  afterEach(() => PluginRegistry.register(fake({ notificationKinds: {} })));

  it("reads a kind as its whole type, not its last word", () => {
    expect(kindLabel("comment.added")).toBe("Comment added");
    expect(kindLabel("work_item.assigned")).toBe("Work item assigned");
    expect(kindLabel("feedback.comment.mentioned")).toBe("Feedback comment mentioned");
    expect(kindLabel("alerts.past_due")).toBe("Alerts past due");
  });

  it("keeps kinds that share a last word apart", () => {
    const mentioned = ["comment.mentioned", "note.mentioned", "chat.mentioned", "feedback.comment.mentioned"];
    expect(new Set(mentioned.map(kindLabel)).size).toBe(mentioned.length);
  });

  it("ignores a plugin's label for a type that isn't under its own prefix", () => {
    PluginRegistry.register(
      fake({ notificationKinds: { "comment.added": "Hijacked", "otherplugin.thing.done": "Not yours" } }),
    );
    expect(kindLabel("comment.added")).toBe("Comment added");
    expect(kindLabel("otherplugin.thing.done")).toBe("Otherplugin thing done");
  });

  it("uses the label a plugin registers for its own kind", () => {
    PluginRegistry.register(fake({ notificationKinds: { "kindtest.eow.submitted": "End-of-week wrap-ups" } }));
    expect(kindLabel("kindtest.eow.submitted")).toBe("End-of-week wrap-ups");
    // Unregistered kinds of the same plugin still read as their type.
    expect(kindLabel("kindtest.rollup.ready")).toBe("Kindtest rollup ready");
  });
});
