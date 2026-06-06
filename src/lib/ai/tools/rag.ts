import type { ToolDefinition } from "../tools";

export const ragTools: ToolDefinition[] = [
  {
    name: "semantic_search",
    description:
      "Search across notes, work items, contracts, and meetings using semantic similarity. Use this for queries like 'find me notes about Q4 planning' or 'what work items mention the security audit' — it returns the most relevant rows across all four types in one call, scored 0–1 by similarity. The current implementation is keyword-overlap based, so it favors literal word reuse over paraphrase.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query in natural language",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["note", "work_item", "contract", "meeting"],
          },
          description:
            "Restrict to specific entity types. Omit to search all four. Pass a subset to focus the search.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 25).",
        },
      },
      required: ["query"],
    },
  },
];
