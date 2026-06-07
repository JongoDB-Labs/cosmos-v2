// src/lib/ai/connectors/jira.descriptor.ts
//
// Jira (Cloud) expressed as a ConnectorDescriptor — mirrors the GitHub pattern
// (tools/jira.ts defs + executors/jira.ts dispatch). availability:"all" — Jira is a
// gov-usable native connector behind our own egress fence (token sealed in the vault;
// the model only ever sees what the gate projects).
//
// EGRESS — gov sees STRUCTURAL ONLY; content WITHHELD (default-deny):
//   - TOOL_ENTITY:
//       jira_search_issues / jira_get_issue → jira_issue
//       jira_list_projects                  → jira_project
//       (jira_create_issue is intentionally UNMAPPED — its result is re-gated by the
//        same maps via projectResult on the created entity; the write returns only the
//        key, and an unmapped tool ⇒ full withhold for gov, which is the safe floor.)
//   - EXPOSABLE_FIELDS:
//       jira_issue:   key, status, priority, issueType, created, updated,
//                     resolutiondate, assigneeAccountId (opaque id — NOT name/email).
//                     WITHHOLD: summary, description, comments, labels, reporter/
//                     assignee display names/emails (PII), all free-text content.
//       jira_project: id, key, projectTypeKey. WITHHOLD: name, description, lead name.
//   - HANDLEABLE_FIELDS: NONE — Jira has no handleable CUI string field (the model
//                     orchestrates BY issue key / project key under the MAC ceiling,
//                     never by referencing a summary/description). Omitted on purpose.

import type { ConnectorDescriptor } from "./types";
import { jiraTools } from "../tools/jira";
import { executeJiraTool } from "../executors/jira";

export const jiraConnector: ConnectorDescriptor = {
  provider: "jira",
  availability: "all", // gov-usable (unlike the commercial-only Nango breadth connector)
  toolDefs: jiraTools,
  execute: (name, input, ctx) =>
    executeJiraTool(name, input, { userId: ctx.userId, orgId: ctx.orgId }),
  egress: {
    jira_search_issues: { entityType: "jira_issue" },
    jira_get_issue: { entityType: "jira_issue" },
    jira_list_projects: { entityType: "jira_project" },
  },
  exposableFields: {
    // jiraSearchIssues/jiraGetIssue return a shallow issue shape including
    // summary/description (content). Structural ONLY: key + status/priority/issueType
    // (enums) + timestamps + the opaque assignee account id. summary/description and
    // any reporter/assignee NAME/EMAIL are content/PII → WITHHELD.
    jira_issue: [
      "key",
      "status",
      "priority",
      "issueType",
      "created",
      "updated",
      "resolutiondate",
      "assigneeAccountId",
    ],
    // jiraListProjects returns id/key/name/projectTypeKey. Structural ONLY: id + key
    // + projectTypeKey. `name`/`description`/lead are content/PII → WITHHELD.
    jira_project: ["id", "key", "projectTypeKey"],
  },
  // No handleableFields: Jira has no handleable CUI string field (see header).
};
