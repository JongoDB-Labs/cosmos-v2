import { prisma } from "@/lib/db/client";
import { runModelTurn, toModelTools, type EgressContext } from "@/lib/ai/egress";

export interface ItemProposal {
  type: "ISSUE" | "MILESTONE";
  title: string;
  sourceAnchor: string | null;
}

const PROPOSE_TOOL = {
  name: "propose_items",
  description: "Propose project items extracted from the document content.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["ISSUE", "MILESTONE"] },
            title: { type: "string", description: "concise, specific item title" },
            sourceAnchor: { type: "string", description: "the [anchor] of the block it came from" },
          },
          required: ["type", "title"],
        },
      },
    },
    required: ["items"],
  },
};

const SYSTEM =
  "You extract actionable project items from a document. Call propose_items EXACTLY once. " +
  "Propose type ISSUE for each clearly actionable task or deliverable, and MILESTONE for each dated " +
  "event/deadline. Use a short, specific title. Set sourceAnchor to the [anchor] shown before the " +
  "block the item came from. Only propose items grounded in the document — never invent. If the " +
  "content is withheld or empty, return an empty list.";

/**
 * Ask the in-tenant LLM (through the CUI-aware egress chokepoint) to propose
 * project items from a document's blocks. NO DB writes — the caller reviews and
 * accepts each proposal (which then runs the convert path). Marked/CUI content is
 * withheld by the egress before the model sees it, so proposals are only grounded
 * in releasable content.
 */
export async function proposeItems(input: {
  orgId: string;
  projectId: string;
  userId: string;
  docId: string;
}): Promise<ItemProposal[]> {
  const doc = await prisma.document.findFirst({
    where: { id: input.docId, orgId: input.orgId, projectId: input.projectId },
    select: {
      id: true,
      title: true,
      blocks: { orderBy: { ordinal: "asc" }, select: { anchor: true, kind: true, text: true } },
    },
  });
  if (!doc) throw new Error("Document not found");

  const anchors = new Set(doc.blocks.map((b) => b.anchor));
  const docText = doc.blocks
    .filter((b) => b.kind !== "PAGE_BREAK" && b.text.trim())
    .map((b) => `[${b.anchor}] (${b.kind}) ${b.text}`)
    .join("\n")
    .slice(0, 24_000);

  const org = await prisma.organization.findUnique({
    where: { id: input.orgId },
    select: { tenantClass: true },
  });
  const tenantClass = org?.tenantClass === "COMMERCIAL" ? "commercial" : "gov";

  const ctx: EgressContext = {
    orgId: input.orgId,
    userId: input.userId,
    conversationId: `doc-propose-${input.docId}`,
    turn: 0,
    tenantClass,
    mode: "enforced",
  };

  const result = await runModelTurn({
    ctx,
    system: SYSTEM,
    messages: [{ role: "user", content: `Document "${doc.title}":\n\n${docText}` }],
    tools: toModelTools([PROPOSE_TOOL]),
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    maxTokens: 2048,
  });

  const call = result.toolUses.find((t) => t.name === "propose_items");
  const rawItems = (call?.input as { items?: unknown })?.items;
  const items = Array.isArray(rawItems) ? rawItems : [];

  return items
    .map((raw) => {
      const r = raw as { type?: string; title?: string; sourceAnchor?: string };
      if (!r.title) return null;
      const proposal: ItemProposal = {
        type: r.type === "MILESTONE" ? "MILESTONE" : "ISSUE",
        title: String(r.title).slice(0, 500),
        sourceAnchor: r.sourceAnchor && anchors.has(r.sourceAnchor) ? r.sourceAnchor : null,
      };
      return proposal;
    })
    .filter((x): x is ItemProposal => x !== null)
    .slice(0, 30);
}
