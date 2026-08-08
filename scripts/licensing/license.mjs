#!/usr/bin/env node
/**
 * Issue and inspect Cosmos entitlement licences (ADR 0004, Tier 1).
 *
 * Deliberately a standalone script with no imports from src/: issuing happens on
 * the VENDOR's machine, near the private key, and must not require a built app
 * or a database. Node's stdlib only.
 *
 *   node scripts/licensing/license.mjs keygen --out ./keys
 *   node scripts/licensing/license.mjs issue --key ./keys/cosmos-license.key \
 *        --org <uuid|*> --plugins whiteboard,pi-planning --days 400 [--instance alpha] [--plan enterprise]
 *   node scripts/licensing/license.mjs inspect --pub ./keys/cosmos-license.pub --token <token|@file>
 *
 * THE PRIVATE KEY NEVER LEAVES THE VENDOR. Anyone holding it can mint licences
 * for every deployment, so treat it exactly like a code-signing key: generated
 * once, stored in a password manager or an HSM/KMS, never committed, never in
 * an image layer, never pasted into a chat.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PREFIX = "cosmos-lic.v1";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else out._.push(a);
  }
  return out;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** `@path` reads from a file; anything else is the literal value. */
const readMaybeFile = (v) => (typeof v === "string" && v.startsWith("@") ? readFileSync(v.slice(1), "utf8").trim() : v);

function keygen(o) {
  const dir = o.out || "./keys";
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const priv = privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = publicKey.export({ type: "spki", format: "pem" });

  const privPath = join(dir, "cosmos-license.key");
  const pubPath = join(dir, "cosmos-license.pub");
  writeFileSync(privPath, priv);
  // 0600 immediately, not after the fact: the window where a signing key is
  // world-readable is the whole vulnerability.
  chmodSync(privPath, 0o600);
  writeFileSync(pubPath, pub);

  console.log(`private key  ${privPath}   (chmod 600 — back this up, never commit it)`);
  console.log(`public key   ${pubPath}`);
  console.log("");
  console.log("Set on every deployment that should verify licences:");
  console.log("");
  console.log("COSMOS_LICENSE_PUBLIC_KEY=" + JSON.stringify(pub.toString()));
}

function issue(o) {
  if (!o.key) die("--key <path to private key> is required");
  if (!o.org) die("--org <uuid|*> is required");
  if (!o.plugins) die("--plugins <slug,slug|*> is required");

  const days = Number(o.days ?? 365);
  if (!Number.isFinite(days) || days <= 0) die("--days must be a positive number");

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    lid: randomUUID(),
    orgId: String(o.org),
    instance: String(o.instance ?? "*"),
    plugins: String(o.plugins).split(",").map((s) => s.trim()).filter(Boolean),
    ...(o.plan ? { plan: String(o.plan) } : {}),
    iat: now,
    exp: now + Math.round(days * 86400),
  };

  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const key = createPrivateKey(readFileSync(o.key, "utf8"));
  const sig = sign(null, Buffer.from(`${PREFIX}.${payload}`, "utf8"), key).toString("base64url");
  const token = `${PREFIX}.${payload}.${sig}`;

  console.error(`licence ${claims.lid}`);
  console.error(`  org       ${claims.orgId}`);
  console.error(`  instance  ${claims.instance}`);
  console.error(`  plugins   ${claims.plugins.join(", ")}`);
  console.error(`  expires   ${new Date(claims.exp * 1000).toISOString()} (${days} days)`);
  console.error("");
  // Token to stdout ALONE, so `> license.txt` produces a usable file and the
  // human-readable summary above does not end up inside it.
  console.log(token);
}

function inspect(o) {
  if (!o.pub) die("--pub <path to public key> is required");
  if (!o.token) die("--token <token|@file> is required");

  const token = readMaybeFile(o.token);
  const parts = String(token).trim().split(".");
  if (parts.length !== 4) die("not a licence token");
  const [name, version, payload, sig] = parts;
  if (`${name}.${version}` !== PREFIX) die(`unsupported token ${name}.${version}`);

  const pub = createPublicKey(readFileSync(o.pub, "utf8"));
  const good = verify(null, Buffer.from(`${PREFIX}.${payload}`, "utf8"), pub, Buffer.from(sig, "base64url"));
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  console.log(JSON.stringify(claims, null, 2));
  console.log("");
  console.log(`signature  ${good ? "VALID" : "INVALID — not issued by this key"}`);
  const left = claims.exp - Math.floor(Date.now() / 1000);
  console.log(`expiry     ${left > 0 ? `${Math.floor(left / 86400)} days left` : "EXPIRED"}`);
  if (!good) process.exit(2);
}

const o = args(process.argv.slice(2));
const cmd = o._[0];
if (cmd === "keygen") keygen(o);
else if (cmd === "issue") issue(o);
else if (cmd === "inspect") inspect(o);
else {
  console.error("usage: license.mjs <keygen|issue|inspect> [options]  — see the header of this file");
  process.exit(1);
}
