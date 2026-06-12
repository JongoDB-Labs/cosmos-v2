#!/usr/bin/env node
/**
 * COSMOS Roadmap ingest — minimal stdio MCP server (zero dependencies).
 *
 * Point an MCP-capable LLM client (e.g. Claude Desktop) at this so it can ingest
 * a roadmap straight into a COSMOS project. It's a thin wrapper over the HTTP
 * ingest API (docs/roadmap/roadmap-ingest.md); the model does the document →
 * schema conversion, this server just authenticates and POSTs.
 *
 * Config via env:
 *   COSMOS_BASE_URL   e.g. https://cosmos.example.com   (required)
 *   COSMOS_ORG_ID     org uuid                          (required)
 *   COSMOS_PROJECT_ID project uuid                       (required)
 *   COSMOS_COOKIE     a logged-in session cookie header  (required — the API is
 *                     session-authenticated; copy the `session=…` cookie)
 *
 * Example client config:
 *   { "command": "node", "args": ["tools/roadmap-mcp/server.mjs"],
 *     "env": { "COSMOS_BASE_URL": "...", "COSMOS_ORG_ID": "...",
 *              "COSMOS_PROJECT_ID": "...", "COSMOS_COOKIE": "session=..." } }
 */
import { createInterface } from "node:readline";

const { COSMOS_BASE_URL, COSMOS_ORG_ID, COSMOS_PROJECT_ID, COSMOS_COOKIE } = process.env;
const API = () =>
  `${COSMOS_BASE_URL}/api/v1/orgs/${COSMOS_ORG_ID}/projects/${COSMOS_PROJECT_ID}/roadmap-nodes`;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id, data) {
  send({ jsonrpc: "2.0", id, result: data });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function apiFetch(path, init = {}) {
  if (!COSMOS_BASE_URL || !COSMOS_ORG_ID || !COSMOS_PROJECT_ID || !COSMOS_COOKIE) {
    throw new Error("Set COSMOS_BASE_URL, COSMOS_ORG_ID, COSMOS_PROJECT_ID, COSMOS_COOKIE");
  }
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: COSMOS_COOKIE,
      Origin: COSMOS_BASE_URL,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const TOOLS = [
  {
    name: "roadmap_template",
    description:
      "Fetch the COSMOS roadmap import schema, a worked example, and the LLM prompt. " +
      "Call this first to learn the exact `nodes` shape before ingesting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "roadmap_ingest",
    description:
      "Ingest a roadmap node set into the configured COSMOS project. `nodes` must " +
      "match the template (each node has kind + title; optional externalRef, body " +
      "(markdown), parentRef, category, meta). mode 'replace' (default) reinstalls, " +
      "'merge' upserts. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["replace", "merge"], default: "replace" },
        nodes: { type: "array", items: { type: "object" } },
      },
      required: ["nodes"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "roadmap_template") {
    const tmpl = await apiFetch(`${API()}/import`);
    return JSON.stringify(tmpl, null, 2);
  }
  if (name === "roadmap_ingest") {
    const report = await apiFetch(`${API()}/import`, {
      method: "POST",
      body: JSON.stringify({ mode: args.mode ?? "replace", nodes: args.nodes ?? [] }),
    });
    return `Ingest complete: ${JSON.stringify(report)}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cosmos-roadmap-ingest", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized") {
      // notification — no response
    } else if (method === "tools/list") {
      result(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const text = await callTool(params?.name, params?.arguments ?? {});
      result(id, { content: [{ type: "text", text }] });
    } else if (method === "ping") {
      result(id, {});
    } else if (id !== undefined) {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) {
      result(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
});
