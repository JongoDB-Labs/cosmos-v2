// scripts/check-dependency-licenses.mjs
//
// Licence-compatibility gate for PRODUCTION dependencies.
//
// The SCA jobs check dependencies for VULNERABILITIES. Nothing checked them for
// LICENCE COMPATIBILITY, which for a public AGPL-3.0 project is the larger
// exposure: a single source-available or copyleft package pulled in by a routine
// `npm install` can make the distributed image impossible to convey under the
// licence the repository claims — and no vulnerability scanner will ever say so.
//
// Scope is deliberately the production tree only. devDependencies are not
// distributed, so a GPL test runner is irrelevant; what matters is what ends up
// inside the image.
//
// Findings are DENIED by default. A package may only pass by being written into
// `.license-allowlist` WITH A REASON — same shape as `.trivyignore`, and for the
// same purpose: an accepted risk that someone signed their name to beats a
// silent pass every time.
//
//   node scripts/check-dependency-licenses.mjs           # gate (exit 1 on findings)
//   node scripts/check-dependency-licenses.mjs --report  # full inventory, never fails

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const REGISTER = ".license-allowlist";
const REPORT_ONLY = process.argv.includes("--report");

/** Permissive — no obligation that affects how the combined work is conveyed. */
const PERMISSIVE = [
  /^MIT$/i, /^MIT[-/]/i, /^ISC$/i, /^BSD/i, /^Apache-2\.0$/i, /^Apache 2/i,
  /^0BSD$/i, /^Unlicense$/i, /^CC0-1\.0$/i, /^CC-BY-(3|4)/i, /^BlueOak/i,
  /^Python-2\.0$/i, /^Zlib$/i, /^WTFPL$/i, /^PostgreSQL$/i, /^AFL-/i,
  /^UPL-/i, /^Ruby$/i, /^JSON$/i,
];

/**
 * Weak / file-level copyleft — obligations attach to that library's own files,
 * not to the work it is combined with. Allowed, but always reported: they carry
 * real duties (keep the library replaceable, publish modifications to it).
 */
const WEAK = [/^LGPL-/i, /^MPL-/i, /^EPL-/i, /^CDDL/i, /^MS-PL$/i, /^Artistic-/i];

/** Strong copyleft — would infect the combined work. */
const STRONG = [/^AGPL-/i, /^GPL-/i, /^GPL$/i, /^SSPL/i, /^OSL-/i, /^EUPL/i, /^CPAL/i, /^CECILL-2/i];

/**
 * Source-available with usage RESTRICTIONS. These are the dangerous ones,
 * because AGPL-3.0 §7 forbids imposing further restrictions on recipients — so
 * a restricted package inside an AGPL distribution is a conflict, not a warning.
 * They also evade classification: npm shows "SEE LICENSE IN ...", GitHub shows
 * "NOASSERTION", and every automated tool shrugs.
 */
const RESTRICTED = [
  /^Elastic/i, /^ELv2$/i, /^BUSL/i, /^BSL-/i, /Commons.?Clause/i, /^PolyForm/i,
  /^SEE LICEN[SC]E/i, /^UNLICENSED$/i, /^Proprietary/i, /^NOASSERTION$/i, /^Custom/i,
];

const match = (list, id) => list.some((re) => re.test(id));

/**
 * Evaluate an SPDX expression: OR passes if ANY side passes, AND only if ALL do.
 * A package offered as "MIT OR GPL-2.0" is one we may take under MIT.
 */
function verdict(expr) {
  const id = String(expr ?? "").trim();
  if (!id) return { kind: "unknown", id: "(none declared)" };

  const bare = id.replace(/[()]/g, " ").trim();
  if (/\sOR\s/i.test(bare)) {
    const parts = bare.split(/\s+OR\s+/i).map((p) => verdict(p));
    const best = parts.find((p) => p.kind === "ok") ?? parts.find((p) => p.kind === "weak");
    return best ? { ...best, id } : { ...parts[0], id };
  }
  if (/\sAND\s/i.test(bare)) {
    const parts = bare.split(/\s+AND\s+/i).map((p) => verdict(p));
    const worst = parts.find((p) => p.kind !== "ok" && p.kind !== "weak");
    return worst ? { ...worst, id } : { kind: "ok", id };
  }

  const one = bare.split(/\s+WITH\s+/i)[0].trim();
  if (match(RESTRICTED, one)) return { kind: "restricted", id };
  if (match(STRONG, one)) return { kind: "strong", id };
  if (match(WEAK, one)) return { kind: "weak", id };
  if (match(PERMISSIVE, one)) return { kind: "ok", id };
  return { kind: "unknown", id };
}

/** Parse the register: `package  # reason` lines, `#` comments, blanks ignored. */
function readRegister() {
  if (!existsSync(REGISTER)) return new Map();
  const entries = new Map();
  for (const raw of readFileSync(REGISTER, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pkg, ...rest] = line.split(/\s+#\s*/);
    const reason = rest.join(" # ").trim();
    // A bare package name is NOT an allowlist entry. An exception nobody
    // justified is indistinguishable from one nobody noticed.
    if (!reason) {
      console.error(`${REGISTER}: "${pkg}" has no reason. Every entry needs "package  # why".`);
      process.exit(2);
    }
    entries.set(pkg.trim(), reason);
  }
  return entries;
}

function productionTree() {
  let raw;
  try {
    raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // npm ls exits non-zero on peer-dep warnings while still emitting valid JSON.
    raw = e.stdout;
  }
  let tree;
  try {
    tree = JSON.parse(raw ?? "");
  } catch {
    // Never degrade to "found nothing, all clear" — an unreadable tree is a
    // failed check, not a passing one.
    console.error("FATAL: could not read the production dependency tree (npm ls produced no JSON).");
    console.error("Run `npm ci` first. Refusing to report a clean result from no data.");
    process.exit(2);
  }
  return tree;
}

/**
 * Unambiguous licence headers, for packages that ship a LICENSE file but never
 * filled in the `license` field. Older packages do this constantly, and calling
 * them "unlicensed" is simply wrong — the grant is right there in the tarball.
 * Deliberately narrow: only headers that cannot be mistaken for another licence.
 */
const FILE_HEADERS = [
  [/\bMIT License\b/i, "MIT"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/\bApache License\b[\s\S]{0,80}Version 2\.0/i, "Apache-2.0"],
  [/\bISC License\b/i, "ISC"],
  [/Redistribution and use in source and binary forms/i, "BSD"],
];

/** Licence declared in a LICENSE/COPYING file, when package.json is silent. */
function licenseFromFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  const file = names.find((n) => /^(licen[sc]e|copying)(\.|$)/i.test(n));
  if (!file) return "";
  let text;
  try {
    text = readFileSync(path.join(dir, file), "utf8").slice(0, 4000);
  } catch {
    return "";
  }
  const hit = FILE_HEADERS.find(([re]) => re.test(text));
  return hit ? { id: hit[1], from: file } : null;
}

/**
 * Licence for a package, and where it was found.
 *
 * `from` is carried separately rather than folded into the identifier: an
 * identifier is fed to the SPDX classifier, and "MIT (read from LICENSE)" is not
 * MIT to a matcher — an earlier cut of this appended the provenance to the id
 * and quietly turned every recovered licence back into an unknown.
 */
function licenseOf(node) {
  const declared = (v) => ({ id: v, from: null });
  if (typeof node.license === "string" && node.license.trim()) return declared(node.license);
  if (node.license?.type) return declared(node.license.type);
  if (Array.isArray(node.licenses)) return declared(node.licenses.map((l) => l.type ?? l).join(" OR "));
  if (node.path) {
    const pj = path.join(node.path, "package.json");
    if (existsSync(pj)) {
      try {
        const p = JSON.parse(readFileSync(pj, "utf8"));
        if (typeof p.license === "string" && p.license.trim()) return declared(p.license);
        if (p.license?.type) return declared(p.license.type);
      } catch { /* fall through to the LICENSE file */ }
    }
    const fromFile = licenseFromFile(node.path);
    if (fromFile) return fromFile;
  }
  return declared("");
}

const tree = productionTree();
const allowlist = readRegister();
const seen = new Map();
/**
 * Listed in the tree but absent from disk — overwhelmingly sharp's per-platform
 * binaries and unmet optional peers. Emphatically NOT "unlicensed": there is no
 * package here to have a licence. Treating the two alike buried the one real
 * finding under sixty false ones the first time this ran.
 *
 * Coverage still holds, because the platform that SHIPS is the one CI installs:
 * the Linux variants resolve and are checked there. Listed below so a genuinely
 * missing package cannot hide in the gap.
 */
const notInstalled = new Set();

(function walk(node) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    if (!dep.path) {
      notInstalled.add(name);
      continue;
    }
    const key = `${name}@${dep.version ?? "?"}`;
    if (seen.has(key)) continue;
    const found = licenseOf(dep);
    seen.set(key, { name, version: dep.version, from: found.from, ...verdict(found.id) });
    walk(dep);
  }
})(tree);

if (seen.size === 0) {
  console.error("FATAL: production tree resolved to zero packages. Run `npm ci` first.");
  process.exit(2);
}

const buckets = { restricted: [], strong: [], unknown: [], weak: [] };
for (const p of seen.values()) if (buckets[p.kind]) buckets[p.kind].push(p);

const findings = [...buckets.restricted, ...buckets.strong, ...buckets.unknown]
  .filter((p) => !allowlist.has(p.name))
  .sort((a, b) => a.name.localeCompare(b.name));

const accepted = [...buckets.restricted, ...buckets.strong, ...buckets.unknown]
  .filter((p) => allowlist.has(p.name));

console.log(`Licence check — ${seen.size} production packages inspected.`);
if (notInstalled.size) {
  console.log(`  Not installed on this platform, so not inspected (${notInstalled.size}):`);
  console.log(`    ${[...notInstalled].sort().join(", ")}`);
  console.log(`  These are platform-specific optionals; the variants that ship are inspected on CI's Linux runner.`);
}

if (buckets.weak.length) {
  console.log(`\nWeak / file-level copyleft — permitted, obligations attach to the library itself:`);
  for (const p of buckets.weak.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${p.name}@${p.version}  [${p.id}]`);
  }
}

if (accepted.length) {
  console.log(`\nAccepted risk (recorded in ${REGISTER}):`);
  for (const p of accepted.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${p.name}@${p.version}  [${p.id}]`);
    console.log(`      ${allowlist.get(p.name)}`);
  }
}

if (REPORT_ONLY) {
  console.log(`\n--report: ${findings.length} finding(s) would fail the gate.`);
  for (const p of findings) console.log(`  ${p.name}@${p.version}  [${p.id}]  (${p.kind})`);
  process.exit(0);
}

if (findings.length === 0) {
  console.log("\nOK — no unreviewed restricted, copyleft or undeclared licences in the production tree.");
  process.exit(0);
}

console.error(`\nFAIL — ${findings.length} production dependenc(ies) need a licence decision:\n`);
const why = {
  restricted: "source-available WITH RESTRICTIONS — AGPL-3.0 §7 forbids imposing further restrictions on recipients, so this conflicts with conveying the combined work under AGPL",
  strong: "strong copyleft — would infect the combined work",
  unknown: "no licence declared — unlicensed code grants no rights",
};
for (const p of findings) {
  console.error(`  ${p.name}@${p.version}`);
  console.error(`      licence: ${p.id}`);
  console.error(`      ${why[p.kind]}`);
}
console.error(`\nEither remove the dependency, or record it in ${REGISTER} as:`);
console.error(`  ${findings[0].name}  # why this is acceptable, and who decided`);
process.exit(1);
