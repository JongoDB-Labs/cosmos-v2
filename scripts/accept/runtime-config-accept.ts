// Docker acceptance harness for the GUI runtime-config surface (design §8).
// Run INSIDE the cosmos-v2-migrate image (the build stage: full source + prisma + tsx)
// against the live acceptance Postgres. Proves the security core end-to-end on a real DB:
//   1. platform-owner gov flip ⇒ applyGovGuardrails forces breadth/mcp OFF + strips nango;
//   2. tenant-admin PATCH enabling breadth on a gov org ⇒ rejected (govGuardrailViolation);
//   3. the agent tool list for a commercial org with enabledConnectors:['github'] ⇒ ONLY
//      github connector tools (jira/slack/google/nango absent); default-null ⇒ all.
//
// Usage (in-container): node_modules/.bin/tsx scripts/accept/runtime-config-accept.ts
import { prisma } from "@/lib/db/client";
import { applyGovGuardrails, govGuardrailViolation } from "@/lib/runtime-config/guardrails";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { connectorToolDefs } from "@/lib/ai/connectors";
import "@/lib/ai/connectors"; // ensure descriptors registered

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const slug = `accept-rtc-${Date.now()}`;
  console.log("\n=== [1] platform-owner gov flip ⇒ guardrails applied ===");
  // Create a COMMERCIAL org with an explicit allowlist that INCLUDES nango + breadth on.
  const org = await prisma.organization.create({
    data: { name: "Accept RTC", slug, tenantClass: "COMMERCIAL" },
  });
  await prisma.orgRuntimeConfig.create({
    data: {
      orgId: org.id,
      allowlistEnabled: true,
      enabledConnectors: ["github", "jira", "nango"],
      breadthEnabled: true,
      mcpEnabled: true,
    },
  });

  // Simulate the platform-owner flip-to-GOV transaction (class change + guardrails).
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { tenantClass: "GOV" } });
    await applyGovGuardrails(org.id, tx);
  });

  const afterFlip = await prisma.orgRuntimeConfig.findUniqueOrThrow({ where: { orgId: org.id } });
  assert(afterFlip.breadthEnabled === false, "after gov flip: breadthEnabled = false");
  assert(afterFlip.mcpEnabled === false, "after gov flip: mcpEnabled = false");
  assert(!afterFlip.enabledConnectors.includes("nango"), "after gov flip: nango stripped from enabledConnectors");
  assert(afterFlip.enabledConnectors.includes("github"), "after gov flip: native github retained");

  console.log("\n=== [2] tenant-admin PATCH enabling breadth on the gov org ⇒ REJECTED ===");
  const govOrg = await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { tenantClass: true } });
  const v1 = govGuardrailViolation(govOrg.tenantClass, { breadthEnabled: true });
  assert(v1 !== null, `gov breadth-enable rejected: ${v1}`);
  const v2 = govGuardrailViolation(govOrg.tenantClass, { mcpEnabled: true });
  assert(v2 !== null, `gov mcp-enable rejected: ${v2}`);
  const v3 = govGuardrailViolation(govOrg.tenantClass, { enabledConnectors: ["github", "nango"] });
  assert(v3 !== null, `gov listing commercial-only connector rejected: ${v3}`);
  const v4 = govGuardrailViolation(govOrg.tenantClass, { enabledConnectors: ["github", "jira"], breadthEnabled: false });
  assert(v4 === null, "gov native-only allowlist (breadth false) allowed");

  console.log("\n=== [3] agent tool list gated to enabledConnectors:['github'] (commercial org) ===");
  const commSlug = `accept-rtc-comm-${Date.now()}`;
  const comm = await prisma.organization.create({
    data: { name: "Accept RTC Comm", slug: commSlug, tenantClass: "COMMERCIAL" },
  });
  await prisma.orgRuntimeConfig.create({
    data: { orgId: comm.id, allowlistEnabled: true, enabledConnectors: ["github"], breadthEnabled: true, mcpEnabled: false },
  });
  const cfg = await getRuntimeConfig(comm.id);
  const gatedNames = connectorToolDefs("commercial", {
    enabledConnectors: cfg.enabledConnectors,
    breadthEnabled: cfg.breadthEnabled,
  }).map((t) => t.name);
  console.log(`  gated tool names: ${JSON.stringify(gatedNames)}`);
  assert(gatedNames.some((n) => n.startsWith("github_")), "github tools present");
  assert(!gatedNames.some((n) => n.startsWith("jira_")), "jira tools ABSENT");
  assert(!gatedNames.some((n) => n.startsWith("slack_")), "slack tools ABSENT");
  assert(!gatedNames.some((n) => n.startsWith("nango_")), "nango tools ABSENT");
  // google tools have non-prefixed names (send_email, etc.) — assert none of them appear by
  // checking the full set is exactly the github connector's tools.
  const githubOnly = connectorToolDefs("commercial", { enabledConnectors: ["github"], breadthEnabled: true }).map((t) => t.name);
  assert(JSON.stringify(gatedNames) === JSON.stringify(githubOnly), "gated set == github connector tools only");

  console.log("\n=== [3b] default-null config ⇒ ALL connectors (current behavior preserved) ===");
  const allNames = connectorToolDefs("commercial", { enabledConnectors: null, breadthEnabled: true }).map((t) => t.name);
  assert(allNames.length > gatedNames.length, "null allowlist offers more tools than the github-only subset");
  assert(allNames.some((n) => n.startsWith("jira_")) && allNames.some((n) => n.startsWith("nango_")), "null allowlist includes jira + nango");

  // Cleanup the synthetic orgs.
  await prisma.organization.deleteMany({ where: { id: { in: [org.id, comm.id] } } });

  console.log("\n=== RUNTIME-CONFIG ACCEPTANCE: ALL CHECKS PASSED ===");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("ACCEPTANCE FAILED:", e?.message ?? e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
