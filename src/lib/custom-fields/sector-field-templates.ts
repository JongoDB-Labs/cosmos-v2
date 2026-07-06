import type { FieldType } from "@prisma/client";

/**
 * Sector-specific custom-field sets (FR 454637a9, user-approved 2026-07-06).
 *
 * Each sector gets a curated, OPTIONAL field set that seeds automatically when a
 * project is created from that sector's template, and can be applied to an
 * existing org from Settings → Custom Fields. Keys are namespaced
 * (`aec.trade`) because custom_fields is unique on (orgId, key) — fields are
 * org-scoped, and type BINDINGS (to the sector's built-in item types) are what
 * scope them to the right items; an unbound field would show everywhere.
 *
 * `govcon` is a per-org opt-in set (no govcon template sector exists — the PM
 * suite carries the register-level data); it binds to ALL built-in types.
 * `security-classification` resolves its options from the org's classification
 * vocabulary (the ClassificationLevel enum) at seed time — one source of truth.
 */
export interface SectorFieldDef {
  /** Namespaced org-unique key, e.g. "aec.trade". */
  key: string;
  name: string;
  fieldType: FieldType;
  /** Static options for SELECT/MULTI_SELECT (ignored when
   *  optionsFromClassifications is set). */
  options?: string[];
  /** Bare type-name suffixes to bind to (e.g. ["bug"]). Omitted = every
   *  built-in type in the sector (or ALL built-in types for govcon). */
  bindTo?: string[];
  /** Resolve options from the org's classification levels at seed time. */
  optionsFromClassifications?: boolean;
}

export const SECTOR_FIELD_TEMPLATES: Record<string, SectorFieldDef[]> = {
  software: [
    { key: "software.environment", name: "Environment", fieldType: "SELECT", options: ["dev", "staging", "prod"] },
    { key: "software.severity", name: "Severity", fieldType: "SELECT", options: ["S1", "S2", "S3", "S4"], bindTo: ["bug"] },
    { key: "software.component", name: "Component", fieldType: "SELECT", options: [] },
    { key: "software.repro-steps", name: "Repro steps", fieldType: "TEXT", bindTo: ["bug"] },
    { key: "software.release-version", name: "Release version", fieldType: "TEXT" },
    { key: "software.pr-url", name: "PR URL", fieldType: "URL" },
  ],
  govcon: [
    { key: "govcon.contract-number", name: "Contract number", fieldType: "TEXT" },
    { key: "govcon.clin", name: "CLIN", fieldType: "TEXT" },
    { key: "govcon.security-classification", name: "Security classification", fieldType: "SELECT", optionsFromClassifications: true },
    { key: "govcon.deliverable-ref", name: "Deliverable ref", fieldType: "TEXT" },
    { key: "govcon.gfe-required", name: "GFE required", fieldType: "CHECKBOX" },
    { key: "govcon.poc-email", name: "POC email", fieldType: "EMAIL" },
  ],
  aec: [
    { key: "aec.trade", name: "Trade", fieldType: "SELECT", options: ["civil", "structural", "mechanical", "electrical", "plumbing", "finishes"] },
    { key: "aec.location-zone", name: "Location / zone", fieldType: "TEXT" },
    { key: "aec.rfi-number", name: "RFI number", fieldType: "TEXT" },
    { key: "aec.submittal-status", name: "Submittal status", fieldType: "SELECT", options: ["pending", "submitted", "approved", "rejected"] },
    { key: "aec.inspection-date", name: "Inspection date", fieldType: "DATE" },
    { key: "aec.permit-required", name: "Permit required", fieldType: "CHECKBOX" },
  ],
  consulting: [
    { key: "consulting.client-poc", name: "Client POC", fieldType: "EMAIL" },
    { key: "consulting.engagement-phase", name: "Engagement phase", fieldType: "SELECT", options: ["discovery", "delivery", "closeout"] },
    { key: "consulting.billable", name: "Billable", fieldType: "CHECKBOX" },
    { key: "consulting.deliverable-due", name: "Deliverable due", fieldType: "DATE" },
    { key: "consulting.sow-ref", name: "SOW ref", fieldType: "TEXT" },
  ],
  education: [
    { key: "education.course-module", name: "Course module", fieldType: "TEXT" },
    { key: "education.audience-level", name: "Audience level", fieldType: "SELECT", options: ["intro", "intermediate", "advanced"] },
    { key: "education.delivery-format", name: "Delivery format", fieldType: "SELECT", options: ["in-person", "virtual", "hybrid", "self-paced"] },
    { key: "education.materials-url", name: "Materials URL", fieldType: "URL" },
    { key: "education.accreditation-required", name: "Accreditation required", fieldType: "CHECKBOX" },
  ],
  event: [
    { key: "event.venue", name: "Venue", fieldType: "TEXT" },
    { key: "event.event-date", name: "Event date", fieldType: "DATE" },
    { key: "event.vendor-contact", name: "Vendor contact", fieldType: "EMAIL" },
    { key: "event.budget-line", name: "Budget line", fieldType: "NUMBER" },
    { key: "event.attendee-impact", name: "Attendee impact", fieldType: "SELECT", options: ["all", "vip", "staff"] },
    { key: "event.contract-signed", name: "Contract signed", fieldType: "CHECKBOX" },
  ],
  manufacturing: [
    { key: "manufacturing.work-center", name: "Work center", fieldType: "SELECT", options: [] },
    { key: "manufacturing.part-number", name: "Part number", fieldType: "TEXT" },
    { key: "manufacturing.lot-size", name: "Lot size", fieldType: "NUMBER" },
    { key: "manufacturing.qc-required", name: "QC required", fieldType: "CHECKBOX" },
    { key: "manufacturing.downtime-impact", name: "Downtime impact", fieldType: "SELECT", options: ["none", "line", "plant"] },
    { key: "manufacturing.target-run-date", name: "Target run date", fieldType: "DATE" },
  ],
  ops: [
    { key: "ops.runbook-url", name: "Runbook URL", fieldType: "URL" },
    { key: "ops.system", name: "System", fieldType: "SELECT", options: [] },
    { key: "ops.change-window", name: "Change window", fieldType: "DATE" },
    { key: "ops.rollback-plan", name: "Rollback plan", fieldType: "TEXT" },
    { key: "ops.customer-impact", name: "Customer impact", fieldType: "SELECT", options: ["none", "degraded", "outage"] },
    { key: "ops.approval-needed", name: "Approval needed", fieldType: "CHECKBOX" },
  ],
};

/** The sectors offered by the "Apply sector fields" settings surface. */
export const SECTOR_FIELD_SECTORS = Object.keys(SECTOR_FIELD_TEMPLATES);
