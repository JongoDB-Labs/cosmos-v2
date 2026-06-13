#!/usr/bin/env node
/**
 * COSMOS BYO-LLM ingest — minimal stdio MCP server (zero dependencies).
 *
 * Point an MCP-capable LLM client (e.g. Claude Desktop) at this so it can ingest
 * structured items and documents straight into a COSMOS project. It's a thin
 * wrapper over the bearer-authed HTTP ingest API (docs/byollm/ingest-api.md); the
 * model does the document → schema conversion, this server just authenticates
 * (Authorization: Bearer …) and calls the endpoints.
 *
 * Config via env:
 *   COSMOS_BASE_URL   e.g. https://cosmos.example.com      (required)
 *   COSMOS_ORG_ID     org uuid                              (required)
 *   COSMOS_PROJECT_ID project uuid                          (required)
 *   COSMOS_API_KEY    a minted org API key, "cosmos_…"      (required — mint one
 *                     in Settings → API keys; bearer requests bypass CSRF, so no
 *                     cookie or Origin header is needed)
 *
 * Example client config:
 *   { "command": "node", "args": ["tools/cosmos-mcp/server.mjs"],
 *     "env": { "COSMOS_BASE_URL": "...", "COSMOS_ORG_ID": "...",
 *              "COSMOS_PROJECT_ID": "...", "COSMOS_API_KEY": "cosmos_..." } }
 */
import { createInterface } from "node:readline";

const { COSMOS_BASE_URL, COSMOS_ORG_ID, COSMOS_PROJECT_ID, COSMOS_API_KEY } = process.env;
const BASE = () =>
  `${COSMOS_BASE_URL}/api/v1/orgs/${COSMOS_ORG_ID}/projects/${COSMOS_PROJECT_ID}`;

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
  if (!COSMOS_BASE_URL || !COSMOS_ORG_ID || !COSMOS_PROJECT_ID || !COSMOS_API_KEY) {
    throw new Error("Set COSMOS_BASE_URL, COSMOS_ORG_ID, COSMOS_PROJECT_ID, COSMOS_API_KEY");
  }
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COSMOS_API_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const ITEM_TYPES = ["ISSUE", "MILESTONE", "OBJECTIVE", "GOAL", "CYCLE", "ROADMAP_NODE"];

const TOOLS = [
  {
    name: "cosmos_template",
    description:
      "Fetch the COSMOS item-import template: the per-type JSON schema, a worked " +
      "example, and a ready-to-paste LLM prompt. Call this first to learn the exact " +
      "`items[]` shape before calling items_ingest.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "items_ingest",
    description:
      "Ingest a structured item set into the configured COSMOS project. `items` is a " +
      "flat array; each item has a `type` (one of " + ITEM_TYPES.join(", ") + ") plus " +
      "that type's fields (see cosmos_template). Every item needs a `title` (CYCLE uses " +
      "`name`). Creates one row per item, attributed to the key's minting user.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["create"], default: "create" },
        items: { type: "array", items: { type: "object" } },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "document_ingest",
    description:
      "Upload a document into the project from raw bytes. Provide the file as base64 " +
      "in `dataBase64`, the original `filename` (extension drives format detection), " +
      "and its `contentType`. COSMOS stores, parses, and persists the block tree; the " +
      "returned document id + blocks can then feed blocks_convert.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        contentType: { type: "string" },
        dataBase64: { type: "string" },
        title: { type: "string" },
      },
      required: ["filename", "contentType", "dataBase64"],
      additionalProperties: false,
    },
  },
  {
    name: "document_list",
    description:
      "List the documents already ingested into the configured project (id, title, " +
      "filename, format, status, …), most recent first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "document_get",
    description:
      "Fetch a single document plus its parsed block tree (blocks ordered by ordinal). " +
      "Use the block ids here as `blockId` for blocks_convert.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" } },
      required: ["docId"],
      additionalProperties: false,
    },
  },
  {
    name: "blocks_convert",
    description:
      "Convert one parsed document block into a project item (and a source link back " +
      "to the document). `itemType` is one of " + ITEM_TYPES.join(", ") + "; `title` " +
      "overrides the block-derived title.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        blockId: { type: "string" },
        itemType: { type: "string", enum: ITEM_TYPES },
        title: { type: "string" },
      },
      required: ["docId", "blockId", "itemType"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "cosmos_template") {
    return apiFetch(`${BASE()}/items/import`);
  }
  if (name === "items_ingest") {
    return apiFetch(`${BASE()}/items/import`, {
      method: "POST",
      body: JSON.stringify({ mode: args.mode ?? "create", items: args.items }),
    });
  }
  if (name === "document_ingest") {
    return apiFetch(`${BASE()}/documents`, {
      method: "POST",
      body: JSON.stringify({
        filename: args.filename,
        contentType: args.contentType,
        dataBase64: args.dataBase64,
        ...(args.title !== undefined ? { title: args.title } : {}),
      }),
    });
  }
  if (name === "document_list") {
    return apiFetch(`${BASE()}/documents`);
  }
  if (name === "document_get") {
    return apiFetch(`${BASE()}/documents/${encodeURIComponent(args.docId)}`);
  }
  if (name === "blocks_convert") {
    return apiFetch(`${BASE()}/documents/${encodeURIComponent(args.docId)}/convert`, {
      method: "POST",
      body: JSON.stringify({
        blockId: args.blockId,
        itemType: args.itemType,
        ...(args.title !== undefined ? { title: args.title } : {}),
      }),
    });
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
        serverInfo: { name: "cosmos-byollm-ingest", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized") {
      // notification — no response
    } else if (method === "tools/list") {
      result(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const data = await callTool(params?.name, params?.arguments ?? {});
      result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
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
