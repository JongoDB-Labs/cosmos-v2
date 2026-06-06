import type { ToolDefinition } from "../tools";

export const utilityTools: ToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a public http(s) URL and return its text content (HTML is stripped to text). Refuses localhost / private IPs / non-http(s). Redirects are NOT followed automatically.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
];
