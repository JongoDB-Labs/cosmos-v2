import { PluginRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/index"; // side-effect: client-safe manifests registered

/**
 * The label a notification kind is shown under — a chip, a count, a filter.
 *
 * A plugin may name its own kinds (`notificationKinds` on its manifest); every
 * other kind reads as its WHOLE dotted type: `comment.added` is "Comment added",
 * `feedback.comment.mentioned` is "Feedback comment mentioned". Not just the last
 * word, which is what this did first: four different kinds ended in `.mentioned`
 * and showed as four "Mentioned" chips, and a comment read as "Added". Types are
 * unique, so labels derived from all of a type are too — and still need no
 * lookup table that a new kind could be missing from.
 */
export function kindLabel(type: string): string {
  for (const plugin of PluginRegistry.getAll()) {
    // A plugin names only its own kinds — never a core type, never another
    // plugin's — so it can't relabel what everybody else's inbox shows.
    if (!type.startsWith(pluginKindPrefix(plugin.slug))) continue;
    const named = plugin.notificationKinds?.[type];
    if (named) return named;
  }
  const words = type.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The prefix a plugin's notification types carry: its slug, `-` as `_`. */
export function pluginKindPrefix(slug: string): string {
  return `${slug.replace(/-/g, "_")}.`;
}
