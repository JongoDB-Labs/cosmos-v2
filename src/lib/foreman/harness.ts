/** Pure assembler for the Foreman build harness: given the applicable skills, http
 *  MCP servers, and per-org settings, produce the additive fragment merged into the
 *  Agent SDK query() options. NO I/O — agent.mts fetches the rows, materializes the
 *  skills, unseals headers, and spreads this in. The invariant this file guarantees:
 *  it only ADDS to allowedTools and never changes permissionMode. */
export interface HarnessSkill {
  name: string;
}
export interface HarnessMcpServer {
  name: string;
  url: string;
  headers: Record<string, string> | null;
}
export interface HarnessInput {
  enabled: boolean;
  baseAllowedTools: string[];
  basePermissionMode: "acceptEdits" | "default" | "plan" | "bypassPermissions";
  skills: HarnessSkill[];
  mcpServers: HarnessMcpServer[];
  systemPromptAppend: string | null;
  foremanBrief: string;
}
export interface HarnessOptions {
  settingSources?: ["project"];
  skills?: "all";
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  hooks?: unknown;
  allowedTools: string[];
  permissionMode: HarnessInput["basePermissionMode"];
}

const HTTP = /^https?:\/\//i;

export function assembleHarnessOptions(input: HarnessInput): HarnessOptions {
  const append = [input.foremanBrief, input.systemPromptAppend].filter(Boolean).join("\n\n");
  const systemPrompt = { type: "preset" as const, preset: "claude_code" as const, append };

  if (!input.enabled) {
    return {
      systemPrompt,
      mcpServers: {},
      allowedTools: [...input.baseAllowedTools],
      permissionMode: input.basePermissionMode,
    };
  }

  const mcpServers: HarnessOptions["mcpServers"] = {};
  const mcpTools: string[] = [];
  for (const s of input.mcpServers) {
    if (!HTTP.test(s.url)) continue; // http(s) only — never a local command
    mcpServers[s.name] = { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    mcpTools.push(`mcp__${s.name}`);
  }

  const allowedTools = Array.from(
    new Set([...input.baseAllowedTools, ...(input.skills.length ? ["Skill"] : []), ...mcpTools]),
  );

  return {
    settingSources: ["project"],
    skills: "all",
    systemPrompt,
    mcpServers,
    allowedTools,
    permissionMode: input.basePermissionMode,
  };
}

/** A skill's DB `name` → a safe directory slug for .claude/skills/<slug>/. Pure. */
export function skillDirName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
