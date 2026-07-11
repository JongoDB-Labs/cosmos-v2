import type { ToolDefinition } from "../tools";

/**
 * CRM write + partner/product read tools. Contact reads keep using the existing
 * `query_crm` tool; these add create/update for contacts and list partners +
 * products. Mirrors `api/v1/orgs/[orgId]/crm/contacts/…`, `partners`, `products`.
 */
export const crmTools: ToolDefinition[] = [
  {
    name: "create_crm_contact",
    description:
      "Create a CRM contact. `stage` is case-insensitive and must be one of the pipeline stages (LEAD/QUALIFIED/PROPOSAL/NEGOTIATION/CLOSED_WON/CLOSED_LOST); defaults to LEAD.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name (max 200 chars)" },
        email: { type: "string", description: "Optional email" },
        phone: { type: "string", description: "Optional phone" },
        company: { type: "string", description: "Optional company" },
        title: { type: "string", description: "Optional job title" },
        stage: {
          type: "string",
          description: "Pipeline stage (LEAD/QUALIFIED/PROPOSAL/NEGOTIATION/CLOSED_WON/CLOSED_LOST)",
        },
        ownerId: { type: "string", description: "Optional owner user ID" },
        dealValue: { type: "number", description: "Optional numeric deal value" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_crm_contact",
    description: "Update a CRM contact's fields (name, stage, owner, deal value, …).",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact ID to update" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
        title: { type: "string" },
        stage: {
          type: "string",
          description: "Pipeline stage (LEAD/QUALIFIED/PROPOSAL/NEGOTIATION/CLOSED_WON/CLOSED_LOST)",
        },
        ownerId: { type: "string" },
        dealValue: { type: "number" },
        notes: { type: "string" },
      },
      required: ["contactId"],
    },
  },
  {
    name: "list_partners",
    description: "List the org's partners/vendors (type, status, socio-economic category, performance rating).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. active, inactive)" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: [],
    },
  },
  {
    name: "list_products",
    description: "List the org's products (status, category, currency).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. active, inactive)" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: [],
    },
  },
];
