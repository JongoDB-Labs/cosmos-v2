import type { ToolDefinition } from "../tools";

export const financeTools: ToolDefinition[] = [
  {
    name: "log_revenue",
    description: "Record a revenue line item.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Positive amount" },
        date: { type: "string", description: "Date (YYYY-MM-DD or ISO)" },
        currency: { type: "string", description: "ISO currency code (default USD)" },
        client: { type: "string" },
        product: { type: "string" },
        description: { type: "string" },
        type: {
          type: "string",
          enum: ["RECURRING", "ONE_TIME", "PROJECT_BASED"],
          description: "Default ONE_TIME",
        },
      },
      required: ["amount", "date"],
    },
  },
  {
    name: "log_expense",
    description: "Record an expense line item.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Positive amount" },
        date: { type: "string", description: "Date (YYYY-MM-DD or ISO)" },
        currency: { type: "string", description: "ISO currency code (default USD)" },
        category: { type: "string", description: "Required category label" },
        vendor: { type: "string" },
        description: { type: "string" },
        recurring: { type: "boolean", description: "Default false" },
      },
      required: ["amount", "date", "category"],
    },
  },
  {
    name: "get_finance_summary",
    description:
      "Return totals (revenue, expenses, netIncome), per-type breakdowns, and a 12-month trend. Optional date range narrows revenue + expense totals (trend still spans 12 months).",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "ISO date — lower bound for revenue/expense totals" },
        endDate: { type: "string", description: "ISO date — upper bound for revenue/expense totals" },
      },
      required: [],
    },
  },
];
