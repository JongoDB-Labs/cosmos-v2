import type { ToolDefinition } from "../tools";

/**
 * Slack tool catalog for the AI assistant — READ-focused + one safe write.
 *
 * These tools require the ORG to have connected Slack via the integrations page (a
 * Bot User OAuth Token, `xoxb-…`, sealed into the org-level vault credential — see
 * `src/lib/integrations/credentials.ts` getOrgCredential + the install/config secret
 * split). The token is org-shared, NOT per-user. Each tool's executor lives in
 * `src/lib/ai/executors/slack.ts` — dispatched from `src/lib/ai/tool-executor.ts`
 * via the connector registry.
 *
 * `channel` defaults to the integration's configured `defaultChannel` (an id) for the
 * write tool when omitted, so the assistant can post without restating it.
 *
 * Results flow through the egress chokepoint: gov tenants see STRUCTURAL fields only
 * (message ts/channel/user/type; channel id/is_private/is_archived/created), never the
 * message text, blocks, attachments, channel name/topic/purpose, or any profile/PII.
 */
export const slackTools: ToolDefinition[] = [
  {
    name: "slack_list_channels",
    description:
      "List Slack channels the bot can see (read-only). Returns each channel's id, private/archived flags, and created timestamp. Use a channel id with slack_search_messages / slack_post_message.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max channels to return (default 50, max 200).",
        },
      },
      required: [],
    },
  },
  {
    name: "slack_search_messages",
    description:
      "Search Slack messages matching a query (read-only). Returns each match's message id (ts), channel id, author id, and type. (The message text is fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query (Slack search syntax, e.g. 'deploy in:#ops').",
        },
        limit: {
          type: "integer",
          description: "Max matches to return (default 20, max 50).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "slack_post_message",
    description:
      "Post a message to a Slack channel (the one write tool). Requires a channel id and the message text. Returns the posted message's id (ts) and channel id. channel defaults to the integration's configured default channel when omitted.",
    input_schema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            "The channel id to post to (e.g. 'C0123ABCD'). Omit to use the integration's default channel.",
        },
        text: {
          type: "string",
          description: "The message text to post.",
        },
      },
      required: ["text"],
    },
  },
];
