/**
 * DEMO / WALKTHROUGH roadmap for the "Apex Defense Systems" demo org (project
 * SENTINEL). This is MOCK data — safe to commit and safe to delete. It exists so
 * the Roadmap feature has believable content during a product walkthrough and so
 * the ingest format has a worked example. Real customer roadmaps are NEVER
 * committed (they load from outside the repo into the tenant DB only).
 *
 * Loaded by prisma/seed/roadmap-import.ts (--demo) and by the demo-defense seed
 * chain; removed by the demo teardown. Themed to a CMMC/RMF authorization program
 * to match the existing Apex/Sentinel demo.
 */
import type { RoadmapImportNode } from "../../src/lib/roadmap/types";

export const DEMO_APEX = { orgSlug: "apex-defense", projectKey: "SENTINEL" } as const;

export const DEMO_APEX_ROADMAP: RoadmapImportNode[] = [
  // ── Sections ──
  {
    kind: "SECTION",
    externalRef: "S-1",
    section: "1",
    title: "§1. Program Overview",
    body:
      "> **Demo / walkthrough data.** This roadmap is illustrative sample content for the " +
      "Apex Defense Systems demo and is safe to delete.\n\n" +
      "**Sentinel** is a CMMC Level 2 / RMF authorization effort to field a secure mission " +
      "system. The roadmap below tracks the path to an Authorization to Operate (ATO): " +
      "categorize → implement controls → independent assessment → authorize → continuous monitoring.",
  },
  { kind: "SECTION", externalRef: "S-2", section: "2", title: "§2. Phases", body: "The authorization timeline, phase by phase." },
  { kind: "SECTION", externalRef: "S-3", section: "3", title: "§3. Lines of Effort", body: "Parallel workstreams that carry the program to ATO." },
  { kind: "SECTION", externalRef: "S-4", section: "4", title: "§4. Risk Register", body: "Tracked risks with likelihood, impact and mitigation." },
  { kind: "SECTION", externalRef: "S-5", section: "5", title: "§5. Decisions", body: "Open decisions with a default and a needed-by date." },
  { kind: "SECTION", externalRef: "S-6", section: "6", title: "§6. Milestones", body: "Key dates and hand-offs." },
  { kind: "SECTION", externalRef: "S-7", section: "7", title: "§7. Key Stakeholders", body: "Who owns what on the path to authorization." },

  // ── Phases ──
  { kind: "SUBPHASE", externalRef: "P-0", parentRef: "S-2", title: "P-0 — Categorize & Plan", body: "Categorize the system (FIPS-199), select the control baseline, and draft the SSP outline. **Exit:** approved categorization + project plan." },
  { kind: "SUBPHASE", externalRef: "P-1", parentRef: "S-2", title: "P-1 — Implement Controls", body: "Implement NIST 800-171 / 800-53 controls; stand up logging, MFA/ICAM, and hardening. **Exit:** SSP baseline frozen; POA&M opened for residual gaps." },
  { kind: "SUBPHASE", externalRef: "P-2", parentRef: "S-2", title: "P-2 — Assess (C3PAO)", body: "Independent assessment by the C3PAO against the SSP/SCTM. **Exit:** assessment report + scored POA&M." },
  { kind: "SUBPHASE", externalRef: "P-3", parentRef: "S-2", title: "P-3 — Authorize (ATO)", body: "AO decision brief; risk acceptance; signed ATO. **Exit:** ATO granted." },
  { kind: "SUBPHASE", externalRef: "P-4", parentRef: "S-2", title: "P-4 — Continuous Monitoring", body: "ConMon: ongoing scans, control reviews, and POA&M burn-down under the cATO model." },

  // ── Lines of Effort ──
  { kind: "LOE", externalRef: "LOE-1", parentRef: "S-3", title: "LOE-1 — Compliance & ATO", body: "SSP/SCTM/SAR/POA&M authorship; C3PAO coordination; AO engagement. Phase span: P-0 → P-3." },
  { kind: "LOE", externalRef: "LOE-2", parentRef: "S-3", title: "LOE-2 — Engineering & Hardening", body: "Control implementation, STIG/SCAP hardening, SBOM + container signing, CI/CD security gates. Phase span: P-1 → P-4." },
  { kind: "LOE", externalRef: "LOE-3", parentRef: "S-3", title: "LOE-3 — Operations & Sustainment", body: "Helpdesk, training, and continuous-monitoring operations. Phase span: P-2 onward." },

  // ── Risks ──
  { kind: "RISK", externalRef: "R-1", parentRef: "S-4", category: "Schedule", title: "R-1 — C3PAO scheduling slip", body: "**Likelihood:** Medium · **Impact:** High\n\nAssessor availability may slip the assessment window past the target ATO date.\n\n**Mitigation:** Book the C3PAO in P-1; hold a backup slot.", meta: { likelihood: "Medium", impact: "High", owner: "Program Lead" } },
  { kind: "RISK", externalRef: "R-2", parentRef: "S-4", category: "Technical", title: "R-2 — MFA / ICAM integration gap", body: "**Likelihood:** Medium · **Impact:** High\n\nCAC/PIV integration is incomplete (see SENTINEL-5), risking a control finding.\n\n**Mitigation:** Prioritize ICAM in P-1; validate with a pre-assessment.", meta: { likelihood: "Medium", impact: "High", owner: "Lead Engineer" } },
  { kind: "RISK", externalRef: "R-3", parentRef: "S-4", category: "Compliance", title: "R-3 — POA&M backlog at assessment", body: "**Likelihood:** Low · **Impact:** Medium\n\nToo many open POA&M items at assessment weakens the AO risk picture.\n\n**Mitigation:** Weekly POA&M burn-down review starting P-1.", meta: { likelihood: "Low", impact: "Medium", owner: "Compliance Analyst" } },

  // ── Decisions ──
  { kind: "DECISION", externalRef: "DP-1", parentRef: "S-5", category: "Infrastructure", title: "DP-1 — Cloud baseline (GovCloud vs on-prem)", body: "Choose the hosting baseline.\n\n**Default if not decided:** AWS GovCloud (FedRAMP-High inheritance).\n\n**Needed by:** End of P-0." },
  { kind: "DECISION", externalRef: "DP-2", parentRef: "S-5", category: "Security", title: "DP-2 — SIEM / centralized logging selection", body: "Select the SIEM for audit + ConMon.\n\n**Default if not decided:** Reuse the enterprise SIEM.\n\n**Needed by:** Mid P-1." },
  { kind: "DECISION", externalRef: "DP-3", parentRef: "S-5", category: "Authorization", title: "DP-3 — Authorizing Official of record", body: "Confirm the cognizant AO who signs the ATO.\n\n**Default if not decided:** Existing component AO.\n\n**Needed by:** Start of P-2." },

  // ── Milestones ──
  { kind: "MILESTONE", externalRef: "M-1", parentRef: "S-6", title: "SSP baseline frozen", body: "**When:** End of P-1\n\n**Lead:** ISSM\n\n**Where:** Compliance" },
  { kind: "MILESTONE", externalRef: "M-2", parentRef: "S-6", title: "C3PAO assessment", body: "**When:** P-2\n\n**Lead:** C3PAO\n\n**Where:** Independent assessor" },
  { kind: "MILESTONE", externalRef: "M-3", parentRef: "S-6", title: "ATO granted", body: "**When:** End of P-3\n\n**Lead:** Authorizing Official\n\n**Where:** AO" },

  // ── Stakeholders ──
  { kind: "STAKEHOLDER", externalRef: "STK-AO", parentRef: "S-7", title: "Authorizing Official (AO)", body: "Owns the ATO decision and accepts residual risk." },
  { kind: "STAKEHOLDER", externalRef: "STK-C3PAO", parentRef: "S-7", title: "C3PAO Assessor", body: "Independent CMMC assessor; runs the formal assessment in P-2." },
  { kind: "STAKEHOLDER", externalRef: "STK-ISSM", parentRef: "S-7", title: "ISSM", body: "Owns the SSP, control implementation evidence, and POA&M." },
];
