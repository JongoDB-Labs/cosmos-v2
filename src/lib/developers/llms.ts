import { GUIDES } from "@/content/developers";
import { getBrand } from "@/lib/brand";
import { contractModules } from "@/lib/openapi/contracts.generated";
import { collectContracts } from "@/lib/openapi/registry";
import { API_VERSION } from "@/lib/openapi/version";

/**
 * llms.txt (https://llmstxt.org): the docs flattened for a language model.
 * `full` inlines every guide; the short form links them. Both end with the
 * public operation list, from the same contracts the reference renders.
 */
export function llmsText(full: boolean): string {
  const { name } = getBrand();
  const ops = collectContracts(contractModules)
    .filter((c) => c.stability !== "internal")
    .map((c) => {
      const scopes = c.scopes.length ? ` (scopes: ${c.scopes.join(", ")})` : "";
      return `- ${c.method.toUpperCase()} /api/v1${c.path}: ${c.summary}${scopes}`;
    });

  const out = [
    `# ${name} API`,
    "",
    `> The ${name} REST API under /api/v1, version ${API_VERSION}. Authenticate with \`Authorization: Bearer cosmos_<prefix>_<secret>\` (a personal access token). Errors are application/problem+json with a stable \`code\`. Lists return everything unless you send \`limit\`; then follow the \`Link: rel="next"\` header. The full OpenAPI 3.1 description is at /api/v1/openapi.json.`,
    "",
  ];
  if (full) {
    for (const g of GUIDES) out.push(`## ${g.title}`, "", g.body.trim(), "");
  } else {
    out.push("## Guides", "", ...GUIDES.map((g) => `- [${g.title}](/developers/guides/${g.slug}): ${g.summary}`), "");
    out.push("## Optional", "", "- [Every guide in one file](/developers/llms-full.txt)", "- [OpenAPI description](/api/v1/openapi.json)", "");
  }
  out.push("## Operations", "", ...ops, "");
  return out.join("\n");
}
