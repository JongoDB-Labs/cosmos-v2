/**
 * The text an automation writes (a comment, a notification): a strict
 * `{{name}}` subset with no logic, conditionals or lookups, where each sink
 * names what it may show. A name the sink doesn't allow, or doesn't know,
 * renders as nothing, so a template can never reach a field it wasn't given.
 *
 * Values are substituted as plain text. Comments and notifications render as
 * text in the app, so nothing here is HTML; the one escape is that a value can't
 * itself contain `{{`, so a title can't smuggle in a second template.
 */
export const TEMPLATE_NAMES = ["item.key", "item.title", "item.status", "item.url", "actor.name", "rule.name"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** What each sink may name. Both stay inside Cosmos, for people who can already see the item. */
export const SINK_NAMES: Record<"comment" | "notification", readonly TemplateName[]> = {
  comment: TEMPLATE_NAMES,
  notification: TEMPLATE_NAMES,
};

const TOKEN = /\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/g;

/** The names a template uses that `sink` doesn't allow: shown to the author on save. */
export function unknownNames(template: string, sink: keyof typeof SINK_NAMES): string[] {
  const allowed = new Set<string>(SINK_NAMES[sink]);
  return [...template.matchAll(TOKEN)].map((m) => m[1]).filter((n) => !allowed.has(n));
}

export function renderTemplate(template: string, sink: keyof typeof SINK_NAMES, values: Partial<Record<TemplateName, string | null>>): string {
  const allowed = new Set<string>(SINK_NAMES[sink]);
  return template.replace(TOKEN, (_whole, name: string) => {
    if (!allowed.has(name)) return "";
    return (values[name as TemplateName] ?? "").replace(/\{\{/g, "{ {");
  });
}
