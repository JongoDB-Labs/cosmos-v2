// @vitest-environment node
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GUIDES } from "@/content/developers";
import { headingId } from "@/components/developers/guide-markdown";
import { llmsText } from "../llms";
import { prefillOrgId } from "@/components/developers/reference-view";
import { contractModules } from "@/lib/openapi/contracts.generated";
import { buildDocument, collectContracts } from "@/lib/openapi/registry";
import { PROBLEM_CODES } from "@/lib/openapi/problem-codes";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { API_CHANGELOG } from "@/lib/api-changelog";

const contracts = collectContracts(contractModules);
const pages = new Set(["/developers", "/developers/reference", "/developers/changelog"]);

/** `## Heading` / `### code` lines → the ids GuideMarkdown gives them. */
const anchors = (body: string) =>
  new Set([...body.matchAll(/^#{2,3} (.+)$/gm)].map((m) => headingId(m[1].replace(/`/g, ""))));

describe("guides", () => {
  it("have unique slugs", () => {
    expect(new Set(GUIDES.map((g) => g.slug)).size).toBe(GUIDES.length);
  });

  it("link only to pages and sections that exist", () => {
    const bySlug = new Map(GUIDES.map((g) => [g.slug, g]));
    for (const g of GUIDES) {
      for (const [, path, hash] of g.body.matchAll(/\]\((\/developers[^)#\s]*)(?:#([^)\s]+))?\)/g)) {
        const slug = path.match(/^\/developers\/guides\/(.+)$/)?.[1];
        if (slug) {
          expect(bySlug.has(slug), `${g.slug} → ${path}`).toBe(true);
          if (hash) expect(anchors(bySlug.get(slug)!.body).has(hash), `${g.slug} → ${path}#${hash}`).toBe(true);
        } else {
          expect(pages.has(path) || path.startsWith("/developers/changelog"), `${g.slug} → ${path}`).toBe(true);
        }
      }
    }
  });

  it("the errors guide has a section for every problem code (a problem's `type` links there)", () => {
    const errors = anchors(GUIDES.find((g) => g.slug === "errors")!.body);
    for (const code of Object.keys(PROBLEM_CODES)) expect(errors, code).toContain(code);
  });

  it("the authentication guide lists every scope", () => {
    const body = GUIDES.find((g) => g.slug === "authentication")!.body;
    for (const s of API_KEY_SCOPES) expect(body).toContain(`| \`${s}\` |`);
  });

  it("headingId matches what the problem `type` expects", () => {
    expect(headingId("invalid_request")).toBe("invalid_request");
    expect(headingId("1. Get a token")).toBe("1-get-a-token");
  });
});

describe("API changelog", () => {
  it("is newest first, with unique dates", () => {
    const dates = API_CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });
});

describe("llms.txt", () => {
  const short = llmsText(false);
  const full = llmsText(true);

  it("lists every public operation and no internal one", () => {
    for (const c of contracts) {
      const line = `${c.method.toUpperCase()} /api/v1${c.path}: ${c.summary}`;
      if (c.stability === "internal") expect(short).not.toContain(line);
      else expect(short).toContain(line);
    }
  });

  it("links every guide; the full form inlines them", () => {
    for (const g of GUIDES) {
      expect(short).toContain(`(/developers/guides/${g.slug})`);
      expect(full).toContain(g.body.trim().slice(0, 80));
    }
  });
});

describe("prefillOrgId", () => {
  const spec = buildDocument(contracts, "public") as unknown as {
    paths: Record<string, Record<string, { parameters?: { name?: string; in?: string; example?: unknown }[] }>>;
  };

  it("sets the example on every orgId path parameter, and only there", () => {
    const out = prefillOrgId(spec, "org-1") as typeof spec;
    let seen = 0;
    for (const ops of Object.values(out.paths)) {
      for (const op of Object.values(ops)) {
        for (const p of op.parameters ?? []) {
          if (p.in === "path" && p.name === "orgId") { expect(p.example).toBe("org-1"); seen++; }
          else expect(p.example).not.toBe("org-1");
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("leaves the original alone", () => {
    prefillOrgId(spec, "org-1");
    expect(JSON.stringify(spec)).not.toContain("org-1");
  });
});

it("the pages the guides link to exist", () => {
  const app = join(process.cwd(), "src/app/(developers)/developers");
  for (const p of ["page.tsx", "reference/page.tsx", "changelog/page.tsx", "guides/[slug]/page.tsx", "changelog/rss.xml/route.ts", "llms.txt/route.ts", "llms-full.txt/route.ts"]) {
    expect(existsSync(join(app, p)), p).toBe(true);
  }
});
