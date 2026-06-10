// Standalone UI sweep: sign in as the seeded test user, visit every page at
// desktop + mobile viewports, full-page screenshot each, and record console
// errors / page errors / failed responses. Output → /tmp/cosmos-sweep/.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = "/tmp/cosmos-sweep";
mkdirSync(OUT, { recursive: true });

const ORG = "test-org";
const PK = "test"; // project key (lowercased)
const paths = [
  ["overview", `/${ORG}`],
  ["projects", `/${ORG}/projects`],
  ["project-home", `/${ORG}/projects/${PK}`],
  ["project-boards", `/${ORG}/projects/${PK}/boards`],
  ["project-cycles", `/${ORG}/projects/${PK}/cycles`],
  ["project-okrs", `/${ORG}/projects/${PK}/okrs`],
  ["project-goals", `/${ORG}/projects/${PK}/goals`],
  ["project-kpis", `/${ORG}/projects/${PK}/kpis`],
  ["project-milestones", `/${ORG}/projects/${PK}/milestones`],
  ["project-members", `/${ORG}/projects/${PK}/members`],
  ["project-settings", `/${ORG}/projects/${PK}/settings`],
  ["issues", `/${ORG}/issues`],
  ["chat", `/${ORG}/chat`],
  ["meetings", `/${ORG}/meetings`],
  ["notes", `/${ORG}/notes`],
  ["crm", `/${ORG}/crm`],
  ["contracts", `/${ORG}/contracts`],
  ["products", `/${ORG}/products`],
  ["partners", `/${ORG}/partners`],
  ["analytics", `/${ORG}/analytics`],
  ["analytics-reports", `/${ORG}/analytics/reports`],
  ["finance", `/${ORG}/finance`],
  ["finance-accounting", `/${ORG}/finance/accounting`],
  ["finance-banking", `/${ORG}/finance/banking`],
  ["finance-invoices", `/${ORG}/finance/invoices`],
  ["finance-payroll", `/${ORG}/finance/payroll`],
  ["finance-tax", `/${ORG}/finance/tax`],
  ["time-tracking", `/${ORG}/time-tracking`],
  ["feedback", `/${ORG}/feedback`],
  ["team", `/${ORG}/team`],
  ["settings", `/${ORG}/settings`],
  ["settings-profile", `/${ORG}/settings/profile`],
  ["settings-preferences", `/${ORG}/settings/preferences`],
  ["settings-security", `/${ORG}/settings/security`],
  ["settings-integrations", `/${ORG}/settings/integrations`],
  ["settings-ai", `/${ORG}/settings/ai`],
  ["settings-roles", `/${ORG}/settings/roles`],
  ["settings-custom-fields", `/${ORG}/settings/custom-fields`],
  ["settings-webhooks", `/${ORG}/settings/webhooks`],
  ["settings-themes", `/${ORG}/settings/themes`],
  ["settings-classifications", `/${ORG}/settings/classifications`],
  ["settings-compliance", `/${ORG}/settings/compliance`],
  ["settings-audit-logs", `/${ORG}/settings/audit-logs`],
  ["settings-mcp-servers", `/${ORG}/settings/mcp-servers`],
  ["settings-agent-governance", `/${ORG}/settings/agent-governance`],
  ["settings-templates", `/${ORG}/settings/templates`],
  ["settings-runtime-config", `/${ORG}/settings/runtime-config`],
];

const viewports = [
  ["desktop", { width: 1366, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

const report = [];

const browser = await chromium.launch();
const context = await browser.newContext();
// Sign in (sets session cookie on the context).
const r = await context.request.post(`${BASE}/api/testenv/sign-in`, {
  data: { email: "alice@test.local" },
  headers: { Origin: BASE },
});
if (!r.ok()) {
  console.error("sign-in failed", r.status());
  process.exit(1);
}

for (const [vp, size] of viewports) {
  const page = await context.newPage();
  await page.setViewportSize(size);
  for (const [slug, path] of paths) {
    const consoleErrors = [];
    const pageErrors = [];
    const badResponses = [];
    const onConsole = (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
    };
    const onPageError = (e) => pageErrors.push(String(e).slice(0, 300));
    const onResponse = (resp) => {
      const s = resp.status();
      if (s >= 500) badResponses.push(`${s} ${resp.url().slice(0, 160)}`);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    let navError = null;
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 25000 });
      // settle: wait for main, then a short pause for client hydration/data.
      await page.waitForSelector("main", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch (e) {
      navError = String(e).slice(0, 200);
    }
    const file = `${OUT}/${vp}__${slug}.png`;
    try {
      await page.screenshot({ path: file, fullPage: true });
    } catch (e) {
      navError = (navError ? navError + " | " : "") + "screenshot:" + String(e).slice(0, 120);
    }
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    const entry = { vp, slug, path, navError, consoleErrors, pageErrors, badResponses };
    report.push(entry);
    const flag = navError || pageErrors.length || badResponses.length ? " ⚠️" : (consoleErrors.length ? " (console)" : "");
    console.log(`${vp} ${slug}${flag}`);
  }
  await page.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();

// Print a concise problem summary.
const problems = report.filter((e) => e.navError || e.pageErrors.length || e.badResponses.length);
console.log(`\n=== ${report.length} page-renders, ${problems.length} with hard problems ===`);
for (const p of problems) {
  console.log(`\n[${p.vp}] ${p.slug} (${p.path})`);
  if (p.navError) console.log("  navError:", p.navError);
  for (const e of p.pageErrors) console.log("  pageError:", e);
  for (const b of p.badResponses) console.log("  5xx:", b);
}
const consoleOnly = report.filter((e) => !e.navError && !e.pageErrors.length && !e.badResponses.length && e.consoleErrors.length);
console.log(`\n=== ${consoleOnly.length} pages with console errors only ===`);
for (const p of consoleOnly.slice(0, 40)) {
  console.log(`[${p.vp}] ${p.slug}: ${p.consoleErrors[0]}`);
}
