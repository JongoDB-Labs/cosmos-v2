#!/usr/bin/env node
// scripts/cutover/exposability-snapshot.mjs — EXPOSABILITY-MAP SNAPSHOT (cutover finisher §9 step 9).
//
//   npx tsx scripts/cutover/exposability-snapshot.mjs --out <dir>
//
// Writes, into <dir>, the artifacts a security reviewer reads before signing off a GOV
// tenant's cutover flip:
//   - exposability-map.json   — the canonical (sorted) serialization of the COMPLETE
//                               effective exposability map (the SAME merged maps the egress
//                               gate enforces: projection.ts EXPOSABLE/HANDLEABLE/TOOL_ENTITY
//                               merged with the connector registry). This is what the hash
//                               is taken over; a sign-off is BOUND to it.
//   - exposability-map.md     — a HUMAN-READABLE rendering: per entityType, the exposed
//                               structural fields, the tools that map to it, an explicit
//                               "WITHHELD: everything else (default-deny)" note, and the
//                               commercial-only/availability flag; plus the tool families
//                               that map to NO entity (full withhold) and the map hash.
//   - exposability-map.hash   — the sha256 hash alone (one line), for scripting/diffing.
//
// The hash is STABLE: re-running on an unchanged map produces the SAME hash. Run it, read
// the markdown, confirm the leak tests are green (npm test — golden-egress + projection),
// then write compliance/exposability/signoff/<orgSlug>.json at this hash. BUILD-ONLY: this
// reads code only (no DB, no prod, no Google).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getExposabilityMap, canonicalize, exposabilityHash } from "./lib/exposability.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else {
      console.error(`exposability-snapshot: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/** Render the human-readable markdown a security reviewer signs off on. */
function renderMarkdown(map, hash) {
  const L = [];
  L.push("# COSMOS — Egress Exposability Map (security review artifact)");
  L.push("");
  L.push(
    "> The **field-level default-deny floor** on what a CUI-blind commercial model is " +
      "allowed to **SEE** for each tool result. This is the EXACT merged map the egress " +
      "gate enforces (`src/lib/ai/egress/projection.ts` `EXPOSABLE_FIELDS` / " +
      "`HANDLEABLE_FIELDS` / `TOOL_ENTITY`, merged with the connector registry's " +
      "`connectorEgressMaps()`), serialized verbatim — not a re-hardcoded copy.",
  );
  L.push("");
  L.push(`**Map hash (sha256):** \`${hash}\``);
  L.push("");
  L.push(
    "**The default-deny contract:** for every entity below, ONLY the listed *exposed " +
      "structural fields* survive into the model's view. **Everything else is WITHHELD** " +
      "(all free-text/content/money/PII). *Handle-referenced* fields are CUI strings the " +
      "model may NOT read but may carry by an opaque token. An unknown entity type or any " +
      "non-listed field ⇒ full withhold.",
  );
  L.push("");
  L.push("## Entities (model-visible structural projection)");
  L.push("");
  if (map.entities.length === 0) {
    L.push("_(none)_");
  }
  for (const e of map.entities) {
    L.push(`### \`${e.entityType}\`  —  availability: **${e.availability}**`);
    L.push("");
    L.push(`- **Exposed structural fields (READ):** ${fmtFields(e.exposableFields)}`);
    L.push(
      `- **Handle-referenced CUI fields (REFERENCE-only, opaque token):** ${fmtFields(
        e.handleableFields,
      )}`,
    );
    L.push(`- **Mapping tools:** ${fmtFields(e.tools)}`);
    L.push("- **WITHHELD:** everything else (default-deny) — all content/free-text/money/PII.");
    L.push("");
  }
  L.push("## Tool families with NO entity mapping ⇒ FULL WITHHOLD (default-deny)");
  L.push("");
  L.push(
    "These tool surfaces map to NO structural entity type, so a gov tenant's model sees " +
      "**nothing** of their results (e.g. Google email/doc bodies, Nango provider payloads).",
  );
  L.push("");
  if (map.withheldToolFamilies.length === 0) {
    L.push("_(none)_");
  }
  for (const f of map.withheldToolFamilies) {
    L.push(`- **${f.provider}** (availability: ${f.availability}): ${fmtFields(f.tools)}`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(
    "**Sign-off:** after reviewing this map and confirming the leak tests are green " +
      "(`npm test` — golden-egress + projection contract suites prove no CUI/free-text " +
      "field is ever exposed), write `compliance/exposability/signoff/<orgSlug>.json` = " +
      "`{orgSlug, mapHash, reviewer, signedAt, leakTestPassed:true}` with `mapHash` set to " +
      "the hash above. A gov flip is gated on a sign-off matching the CURRENT hash.",
  );
  L.push("");
  return L.join("\n");
}

function fmtFields(xs) {
  if (!xs || xs.length === 0) return "_(none)_";
  return xs.map((x) => `\`${x}\``).join(", ");
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error("exposability-snapshot: missing required --out <dir>");
    process.exit(2);
  }

  const map = getExposabilityMap();
  const json = canonicalize(map);
  const hash = exposabilityHash(map);
  const md = renderMarkdown(map, hash);

  const outDir = path.resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "exposability-map.json");
  const mdPath = path.join(outDir, "exposability-map.md");
  const hashPath = path.join(outDir, "exposability-map.hash");
  // The canonical JSON is the hashed bytes; pretty-print is NOT used (it would change bytes).
  writeFileSync(jsonPath, json + "\n", "utf8");
  writeFileSync(mdPath, md, "utf8");
  writeFileSync(hashPath, hash + "\n", "utf8");

  if (!args.quiet) {
    console.error(`exposability-snapshot: wrote ${jsonPath}`);
    console.error(`exposability-snapshot: wrote ${mdPath}`);
    console.error(`exposability-snapshot: wrote ${hashPath}`);
    console.error(`exposability-snapshot: ${map.entities.length} entities, hash ${hash}`);
  }
  // Machine-readable line (stdout) for scripting/acceptance.
  console.log(JSON.stringify({ hash, entities: map.entities.length, out: outDir }));
}

main();
