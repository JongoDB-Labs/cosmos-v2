export const topics = {
  org: (id: string) => `org:${id}` as const,
  user: (id: string) => `user:${id}` as const,
  channel: (id: string) => `channel:${id}` as const,
};

export type Topic =
  | ReturnType<typeof topics.org>
  | ReturnType<typeof topics.user>
  | ReturnType<typeof topics.channel>;

export type ParsedTopic = { kind: "org" | "user" | "channel"; id: string };

export function parseTopic(t: string): ParsedTopic | null {
  const colon = t.indexOf(":");
  if (colon === -1) return null;
  const kind = t.slice(0, colon);
  const id = t.slice(colon + 1);
  if (kind !== "org" && kind !== "user" && kind !== "channel") return null;
  if (!id) return null;
  return { kind, id };
}
