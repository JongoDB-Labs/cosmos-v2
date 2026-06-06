import type { ToolDefinition } from "../tools";

export const accountingTools: ToolDefinition[] = [
  {
    name: "get_trial_balance",
    description:
      "Return the trial balance for the org — total debits, total credits, account count, and whether the ledger is balanced.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_profit_and_loss",
    description:
      "Return the profit & loss (income statement) for the org. Optional date range narrows the entries included.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "ISO date — lower bound (inclusive)" },
        endDate: { type: "string", description: "ISO date — upper bound (inclusive)" },
      },
      required: [],
    },
  },
];
