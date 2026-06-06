export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  handledBy: "client" | "server";
  adminOnly?: boolean;
};

export const COMMANDS: SlashCommand[] = [
  { name: "me", usage: "/me <action>", description: "Post an action ('* you wave')", handledBy: "client" },
  { name: "shrug", usage: "/shrug [text]", description: "Append ¯\\_(ツ)_/¯", handledBy: "client" },
  { name: "help", usage: "/help", description: "List available commands", handledBy: "client" },
  { name: "dm", usage: "/dm @user", description: "Open a direct message", handledBy: "client" },
  { name: "topic", usage: "/topic <text>", description: "Set the channel topic", handledBy: "server", adminOnly: true },
  { name: "invite", usage: "/invite @user", description: "Add someone to the channel", handledBy: "server", adminOnly: true },
  { name: "leave", usage: "/leave", description: "Leave this channel", handledBy: "server" },
  { name: "mute", usage: "/mute", description: "Mute notifications for this channel", handledBy: "server" },
  { name: "ai", usage: "/ai <prompt>", description: "Ask the AI assistant", handledBy: "server" },
  { name: "notes", usage: "/notes", description: "AI note-taker: summarize recent messages into decisions + action items", handledBy: "server" },
];

const SLASH_RE = /^\/([a-z][a-z0-9]*)(?:\s+([\s\S]*))?$/i;

export type ParsedSlash = { command: string; args: string; known: boolean };

/** Parse composer text into a slash command, or null if it isn't one. */
export function parseSlash(text: string): ParsedSlash | null {
  const m = text.match(SLASH_RE);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const args = (m[2] ?? "").trim();
  const known = COMMANDS.some((c) => c.name === command);
  return { command, args, known };
}

/** Commands matching a prefix, filtered by whether the user can manage the channel. */
export function matchCommands(prefix: string, canManage: boolean): SlashCommand[] {
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p) && (!c.adminOnly || canManage));
}

export function getCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name.toLowerCase());
}
