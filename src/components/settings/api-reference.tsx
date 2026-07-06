"use client";

import { useState } from "react";
import { Copy, Check, ChevronDown, ChevronRight, Terminal, Server } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * In-app API & MCP reference (FR e0524a67) — rendered under the API Keys manager
 * so a user who just minted a key can see exactly how to use it: the auth model,
 * the scopes, the core endpoints (with THIS org's id pre-filled), and the MCP
 * setup. Mirrors docs/byollm/ingest-api.md but live and copy-pasteable.
 */
export function ApiReference({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  // Resolved client-side so examples use the real public origin.
  const base = typeof window !== "undefined" ? window.location.origin : "https://cosmos.example.com";
  const apiBase = `${base}/api/v1/orgs/${orgId}`;

  return (
    <section className="mt-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-5 py-4 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Terminal className="size-4 text-[var(--primary)]" />
        <span className="font-medium text-[var(--text)]">API &amp; MCP reference</span>
        <span className="ml-2 text-xs text-[var(--text-muted)]">
          how to use your key — endpoints, scopes, MCP
        </span>
      </button>

      {open && (
        <div className="space-y-6 border-t border-[var(--border)] px-5 py-5 text-sm">
          <Prose>
            <p>
              Authenticate any HTTP client (or an MCP-capable LLM) with a Cosmos
              API key and operate on your org&apos;s data. A key is{" "}
              <b>org-scoped</b>, <b>acts as the user who minted it</b>, and its
              effective permissions are that user&apos;s current permissions{" "}
              <b>intersected with the key&apos;s scopes</b> — so a key can never
              grant more than its owner has. Send it as a bearer token; bearer
              requests skip CSRF (no <code>Origin</code> needed).
            </p>
          </Prose>

          <div>
            <H>Scopes</H>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--text-muted)]">
                    <th className="py-1 pr-4 font-medium">Scope</th>
                    <th className="py-1 font-medium">Grants</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  <ScopeRow scope="read" grants="Read projects, items, OKRs, sprints (templates + listing)." />
                  <ScopeRow scope="items:write" grants="Create items — issues, milestones, OKRs, goals, sprints, roadmap." />
                  <ScopeRow scope="documents:write" grants="Upload documents and convert their blocks into items." />
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <H>Quickstart</H>
            <p className="mb-2 text-xs text-[var(--text-muted)]">
              Mint a key above (shown once as <code>cosmos_&lt;prefix&gt;_&lt;secret&gt;</code>),
              then:
            </p>
            <Code
              text={`BASE="${base}"
ORG="${orgId}"
PROJECT="<project-uuid>"
KEY="cosmos_<prefix>_<secret>"
API="$BASE/api/v1/orgs/$ORG/projects/$PROJECT"
AUTH="Authorization: Bearer $KEY"`}
            />
          </div>

          <div>
            <H>Core endpoints</H>
            <p className="mb-2 text-xs text-[var(--text-muted)]">
              Responses are bare JSON. Base for these:{" "}
              <code className="break-all">{apiBase}/projects/&#123;projectId&#125;</code>
            </p>
            <Endpoint method="GET" path="items/import" scope="read" desc="Per-type schema, a worked example, and a ready-to-paste LLM prompt — fetch this first so your model emits a conformant items[] array." />
            <Endpoint method="POST" path="items/import" scope="items:write" desc="Ingest an items[] array (issues / milestones / OKRs / goals / sprints / roadmap). Idempotent create-or-update by mapped external key." />
            <Endpoint method="POST" path="documents" scope="documents:write" desc="Upload a document from base64; Cosmos parses it into blocks." />
            <Endpoint method="GET" path="documents" scope="read" desc="List uploaded documents." />
            <Endpoint method="GET" path="documents/{docId}" scope="read" desc="One document plus its parsed blocks." />
            <Endpoint method="POST" path="documents/{docId}/convert" scope="documents:write" desc="Convert a block into a work item / milestone / OKR, linked back to the source block." />
            <div className="mt-3">
              <Code
                text={`# Fetch the ingest template (what to send), then create items:
curl -s "$API/items/import" -H "$AUTH"

curl -s -X POST "$API/items/import" -H "$AUTH" \\
  -H "Content-Type: application/json" \\
  -d '{"items":[{"type":"issue","title":"Ingested from my agent","priority":"HIGH"}]}'`}
              />
            </div>
          </div>

          <div>
            <H>
              <Server className="mr-1 inline size-3.5" /> MCP server
            </H>
            <Prose>
              <p>
                Point an MCP-capable client (Claude Desktop, etc.) at{" "}
                <code>cosmos-mcp</code> — it exposes the same endpoints as tools,
                so an LLM can read and create items under your RBAC/ABAC. Set the
                same three values as env; see{" "}
                <code>tools/cosmos-mcp/README.md</code> in the repo.
              </p>
            </Prose>
            <Code
              text={`{
  "mcpServers": {
    "cosmos": {
      "command": "npx",
      "args": ["-y", "cosmos-mcp"],
      "env": {
        "COSMOS_BASE_URL": "${base}",
        "COSMOS_ORG_ID": "${orgId}",
        "COSMOS_API_KEY": "cosmos_<prefix>_<secret>"
      }
    }
  }
}`}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-[var(--text)]">{children}</h3>;
}

function Prose({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2 text-[var(--text-muted)] [&_code]:rounded [&_code]:bg-[var(--muted)]/50 [&_code]:px-1 [&_code]:text-[var(--text)]">{children}</div>;
}

function ScopeRow({ scope, grants }: { scope: string; grants: string }) {
  return (
    <tr className="border-t border-[var(--border)]/60">
      <td className="py-1.5 pr-4">
        <code className="rounded bg-[var(--muted)]/50 px-1 text-[var(--text)]">{scope}</code>
      </td>
      <td className="py-1.5 text-[var(--text-muted)]">{grants}</td>
    </tr>
  );
}

function Endpoint({ method, path, scope, desc }: { method: string; path: string; scope: string; desc: string }) {
  const tint =
    method === "GET"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  return (
    <div className="flex items-start gap-2 border-t border-[var(--border)]/60 py-1.5">
      <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", tint)}>{method}</span>
      <div className="min-w-0">
        <code className="text-xs text-[var(--text)]">{path}</code>
        <span className="ml-2 text-[10px] text-[var(--text-muted)]">scope: {scope}</span>
        <p className="text-xs text-[var(--text-muted)]">{desc}</p>
      </div>
    </div>
  );
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-[11px] leading-relaxed text-[var(--text)]">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          try {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
        className="absolute right-2 top-2 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--muted)]/60 hover:text-[var(--text)]"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
