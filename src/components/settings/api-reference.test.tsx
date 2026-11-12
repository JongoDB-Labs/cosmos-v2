// @vitest-environment jsdom
// The MCP snippet under Settings → API keys is pasted into a client config along
// with a live API key, so whatever it tells the client to run receives that key.
// Cosmos publishes no npm package; the server is tools/cosmos-mcp/server.mjs, run
// with Node from a checkout. These tests pin the snippet to that file, and to the
// exact env names the server refuses to start without, read from its own source
// so the two cannot drift apart.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiReference } from "./api-reference";

afterEach(cleanup);

const SERVER = "tools/cosmos-mcp/server.mjs";

/** The env names server.mjs refuses to run without: the ones in its
 *  `if (!A || !B ...) throw new Error(...)` guard. */
function requiredEnvNames(): string[] {
  const src = readFileSync(join(process.cwd(), SERVER), "utf8");
  const guard = src.match(/if\s*\(\s*((?:!\s*[A-Z_][A-Z0-9_]*\s*(?:\|\|\s*)?)+)\)\s*\{\s*throw new Error\(/);
  if (!guard) throw new Error(`no required-env guard found in ${SERVER}`);
  const names = guard[1].split("||").map((s) => s.replace("!", "").trim());
  // Every guarded name must really be read from process.env, or this parsed
  // something other than the env check.
  const fromEnv = src.match(/const\s*\{([^}]*)\}\s*=\s*process\.env/);
  if (!fromEnv) throw new Error(`no process.env destructuring found in ${SERVER}`);
  const envNames = fromEnv[1].split(",").map((s) => s.trim());
  for (const n of names) {
    if (!envNames.includes(n)) throw new Error(`${n} is guarded but not read from process.env`);
  }
  return names;
}

function renderSnippet(orgId = "org-123") {
  const { container } = render(<ApiReference orgId={orgId} />);
  fireEvent.click(screen.getByRole("button", { name: /API & MCP reference/ }));
  const text = Array.from(container.querySelectorAll("pre code"))
    .map((el) => el.textContent ?? "")
    .find((t) => t.includes('"mcpServers"'));
  if (!text) throw new Error("no MCP snippet rendered");
  const cfg = JSON.parse(text) as {
    mcpServers: { cosmos: { command: string; args: string[]; env: Record<string, string> } };
  };
  return { server: cfg.mcpServers.cosmos, container };
}

describe("ApiReference MCP snippet", () => {
  it("runs the repository's server with node, not a package from npm", () => {
    const { server, container } = renderSnippet();
    expect(server.command).toBe("node");
    expect(server.args).toHaveLength(1);
    expect(server.args[0].startsWith("/")).toBe(true);
    expect(server.args[0].endsWith(`/${SERVER}`)).toBe(true);
    expect(container.textContent).not.toMatch(/\bnpx\b/);
  });

  it("sets exactly the env vars server.mjs requires", () => {
    const required = requiredEnvNames();
    expect(required.length).toBeGreaterThan(0);
    const { server } = renderSnippet();
    expect(Object.keys(server.env).sort()).toEqual([...required].sort());
  });

  it("fills in this org and origin, and leaves the project and key as placeholders", () => {
    const { server } = renderSnippet("org-123");
    expect(server.env.COSMOS_BASE_URL).toBe(window.location.origin);
    expect(server.env.COSMOS_ORG_ID).toBe("org-123");
    expect(server.env.COSMOS_PROJECT_ID).toBe("<project-uuid>");
    expect(server.env.COSMOS_API_KEY).toBe("cosmos_<prefix>_<secret>");
  });
});
