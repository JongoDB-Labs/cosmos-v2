// src/lib/ai/policy/domains.test.ts
import { describe, it, expect } from "vitest";
import "@/lib/ai/connectors"; // register the real connector descriptors so cosmosTools is full
import { cosmosTools } from "@/lib/ai/tools";
import { TOOL_DOMAIN, KNOWN_DOMAINS, KNOWN_DOMAIN_SET, DEFAULT_DOMAIN, domainForTool } from "./domains";

describe("TOOL_DOMAIN map", () => {
  it("maps EVERY registered tool (native + connector) to a domain — exhaustive", () => {
    // The live catalog (cosmosTools includes ...connectorToolDefs() at module load). Every one
    // must have an explicit entry so a domain-deny's blast radius is auditable and a NEW tool
    // surfaces as a deliberate edit, not a silent DEFAULT_DOMAIN fallthrough.
    const missing = cosmosTools.map((t) => t.name).filter((name) => !(name in TOOL_DOMAIN));
    expect(missing).toEqual([]);
  });

  it("every TOOL_DOMAIN value is a KNOWN domain", () => {
    for (const [tool, domain] of Object.entries(TOOL_DOMAIN)) {
      expect(KNOWN_DOMAIN_SET.has(domain), `${tool} → ${domain}`).toBe(true);
    }
  });

  it("KNOWN_DOMAINS has no duplicates and includes the default", () => {
    expect(new Set(KNOWN_DOMAINS).size).toBe(KNOWN_DOMAINS.length);
    expect(KNOWN_DOMAIN_SET.has(DEFAULT_DOMAIN)).toBe(true);
  });
});

describe("domainForTool", () => {
  it("returns the mapped domain for a known tool", () => {
    expect(domainForTool("query_finance")).toBe("finance");
    expect(domainForTool("create_work_item")).toBe("work_items");
    expect(domainForTool("send_email")).toBe("google");
    expect(domainForTool("nango_proxy_request")).toBe("nango");
  });

  it("an UNKNOWN tool falls back to the DEFAULT domain (NOT auto-denied)", () => {
    expect(domainForTool("some_future_tool_xyz")).toBe(DEFAULT_DOMAIN);
    expect(domainForTool("")).toBe(DEFAULT_DOMAIN);
  });
});
