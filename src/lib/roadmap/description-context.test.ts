import { describe, it, expect } from "vitest";
import {
  ROADMAP_CONTEXT_START,
  ROADMAP_CONTEXT_END,
  deriveRoadmapRefs,
  decisionGloss,
  riskGloss,
  resolveRef,
  poamFor,
  buildRoadmapContextBlock,
  applyRoadmapContext,
  stripRoadmapContext,
  type RoadmapContextNode,
} from "./description-context";

const BASE = "/defcon-ai/projects/VITLBMA/roadmap";

/** A small in-memory roadmap, shaped like DB rows: extras live in `meta`. */
const NODES: RoadmapContextNode[] = [
  { externalRef: "LOE-1", anchor: "loe-1", title: "LOE-1 — Compliance & ATO", body: "SSP/POA&M authorship." },
  { externalRef: "SP-0", anchor: "sp-0", title: "SP-0 — Categorize & Plan", body: "Categorize the system." },
  {
    externalRef: "DP-01",
    anchor: "dp-01",
    title: "DP-01 — SRE COA selection (primary / secondary / tertiary)",
    body: "SRE COA selection.\n\n**Default if not decided:** Primary: SRE-1 family; Secondary: SRE-2.\n\n**Latest decision date:** End of SP-0",
    meta: { default: "Primary: SRE-1 family; Secondary: SRE-2.", decisionDate: "End of SP-0" },
  },
  {
    externalRef: "DP-13a",
    anchor: "dp-13a",
    title: "DP-13a — Break-glass trigger (LPI)",
    body: "Trigger for BG-1.",
    meta: {},
  },
  {
    externalRef: "R-03",
    anchor: "r-03",
    title: "R-03 — Authorization timing inside compressed window",
    body: "**Likelihood:** High · **Impact:** High\n\nTiming risk.\n\n**Mitigation:** Amend v2 ATO; carry IATT as break-glass.",
    meta: { likelihood: "High", impact: "High", mitigation: "Amend v2 ATO; carry IATT as break-glass.", owner: "ISSM" },
  },
];

const byRef = new Map<string, RoadmapContextNode>();
for (const n of NODES) if (n.externalRef) byRef.set(n.externalRef, n);

describe("deriveRoadmapRefs", () => {
  it("pulls LOE from the LOE column and canonicalises it", () => {
    // Real backlog LOE column values are "LOE1" / "LOE2" / "LOE3".
    expect(deriveRoadmapRefs({ loe: "LOE1" }).loe).toBe("LOE-1");
    expect(deriveRoadmapRefs({ loe: "LOE 3" }).loe).toBe("LOE-3");
    expect(deriveRoadmapRefs({ text: "part of LOE-2 work" }).loe).toBe("LOE-2");
  });

  it("prefers the Sprint column for the sub-phase, then Labels", () => {
    expect(deriveRoadmapRefs({ sprint: "SP-0 kickoff" }).subPhase).toBe("SP-0");
    expect(deriveRoadmapRefs({ labels: "phase SP-BG-1" }).subPhase).toBe("SP-BG-1");
    expect(deriveRoadmapRefs({ sprint: "SP-2", labels: "SP-9" }).subPhase).toBe("SP-2");
  });

  it("collects DP/R refs from the text blob, de-duped in first-seen order", () => {
    const refs = deriveRoadmapRefs({ text: "See DP-13a, R-03, DP-01 and again DP-13a / R-03" });
    expect(refs.decisions).toEqual(["DP-13a", "DP-01"]);
    expect(refs.risks).toEqual(["R-03"]);
  });

  it("returns nulls/empties when there are no refs", () => {
    expect(deriveRoadmapRefs({ text: "no refs here" })).toEqual({
      loe: null,
      subPhase: null,
      decisions: [],
      risks: [],
    });
  });
});

describe("gloss expansion (DP-XX / R-XX become 'what it is', not a bare id)", () => {
  it("decisionGloss surfaces the default from meta", () => {
    expect(decisionGloss(byRef.get("DP-01")!)).toBe("Default: Primary: SRE-1 family; Secondary: SRE-2.");
  });

  it("decisionGloss falls back to the body's '**Default if not decided:**' line", () => {
    const node: RoadmapContextNode = {
      externalRef: "DP-99",
      anchor: "dp-99",
      title: "DP-99",
      body: "Some decision.\n\n**Default if not decided:** Reuse the enterprise baseline.",
      meta: {},
    };
    expect(decisionGloss(node)).toBe("Default: Reuse the enterprise baseline.");
  });

  it("riskGloss surfaces likelihood/impact + mitigation", () => {
    expect(riskGloss(byRef.get("R-03")!)).toBe("High/High · Mitigation: Amend v2 ATO; carry IATT as break-glass.");
  });
});

describe("resolveRef", () => {
  it("resolves a direct ref", () => {
    expect(resolveRef("DP-01", byRef)).toEqual(["DP-01"]);
  });

  it("resolves aliases to the underlying real nodes (skipping unknowns)", () => {
    expect(resolveRef("DP-13", byRef, { "DP-13": ["DP-13a", "DP-99"] })).toEqual(["DP-13a"]);
  });

  it("strips a trailing -ref suffix", () => {
    const map = new Map(byRef);
    map.set("DP-AKS-1", { externalRef: "DP-AKS-1", anchor: "dp-aks-1", title: "DP-AKS-1" });
    expect(resolveRef("DP-AKS-1-ref", map)).toEqual(["DP-AKS-1"]);
  });

  it("returns [] for an unknown ref", () => {
    expect(resolveRef("DP-404", byRef)).toEqual([]);
  });
});

describe("poamFor", () => {
  const poam = [
    { loe: "LOE1", sp: "0", task: "Draft SSP", owner: "ISSM", target: "SP-0", status: "In progress" },
    { loe: "LOE1", sp: "1-2", task: "Implement controls", owner: "Eng", target: "SP-1", status: "Planned" },
    { loe: "LOE2", sp: "1", task: "Harden AKS", owner: "SRE", target: "SP-1", status: "Planned" },
  ];

  it("matches by LOE, tolerating LOE-1 / LOE1 forms", () => {
    expect(poamFor("LOE-1", null, poam).map((t) => t.task)).toEqual(["Draft SSP", "Implement controls"]);
  });

  it("narrows to the sub-phase span when one is present", () => {
    expect(poamFor("LOE-1", "SP-0", poam).map((t) => t.task)).toEqual(["Draft SSP"]);
  });

  it("returns nothing without an LOE", () => {
    expect(poamFor(null, "SP-0", poam)).toEqual([]);
  });
});

describe("buildRoadmapContextBlock", () => {
  it("expands each ref into a titled deep-link + gloss (never a bare id)", () => {
    const refs = deriveRoadmapRefs({ loe: "LOE-1", sprint: "SP-0", text: "DP-01, R-03" });
    const block = buildRoadmapContextBlock({ refs, nodesByRef: byRef, basePath: BASE })!;

    expect(block).toContain(ROADMAP_CONTEXT_START);
    expect(block).toContain(ROADMAP_CONTEXT_END);
    // Deep-links carry the human title and a working roadmap href.
    expect(block).toContain(`[LOE-1 — Compliance & ATO](${BASE}/loe-1)`);
    expect(block).toContain(`[SP-0 — Categorize & Plan](${BASE}/sp-0)`);
    expect(block).toContain(`[DP-01 — SRE COA selection (primary / secondary / tertiary)](${BASE}/dp-01)`);
    expect(block).toContain(`[R-03 — Authorization timing inside compressed window](${BASE}/r-03)`);
    // Glosses explain WHAT the decision/risk is.
    expect(block).toContain("Default: Primary: SRE-1 family");
    expect(block).toContain("High/High · Mitigation:");
    expect(block).toContain("_Source of truth:");
    // The point of the ticket: not just "DP-01" with nothing after it.
    expect(block).not.toMatch(/^- DP-01\s*$/m);
  });

  it("includes a COA-1 POA&M section when activities are supplied", () => {
    const refs = deriveRoadmapRefs({ loe: "LOE-1", sprint: "SP-0" });
    const block = buildRoadmapContextBlock({
      refs,
      nodesByRef: byRef,
      basePath: BASE,
      poam: [{ loe: "LOE1", sp: "0", task: "Draft SSP", owner: "ISSM", target: "SP-0", status: "In progress" }],
    })!;
    expect(block).toContain("**Related COA-1 POA&M activities (LOE 1):**");
    expect(block).toContain("Draft SSP — ISSM · SP-0 · _In progress_");
  });

  it("returns null when no ref resolves to a known node", () => {
    const refs = deriveRoadmapRefs({ text: "DP-404 R-999" });
    expect(buildRoadmapContextBlock({ refs, nodesByRef: byRef, basePath: BASE })).toBeNull();
  });
});

describe("applyRoadmapContext (idempotent splice)", () => {
  const refs = deriveRoadmapRefs({ loe: "LOE-1", text: "DP-01" });
  const block = buildRoadmapContextBlock({ refs, nodesByRef: byRef, basePath: BASE })!;

  it("preserves the user's prose and appends the block", () => {
    const out = applyRoadmapContext("Original human-written description.", block);
    expect(out.startsWith("Original human-written description.")).toBe(true);
    expect(out).toContain(ROADMAP_CONTEXT_START);
  });

  it("is idempotent — applying twice yields the same result (no duplicate block)", () => {
    const once = applyRoadmapContext("Prose.", block);
    const twice = applyRoadmapContext(once, block);
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(ROADMAP_CONTEXT_START, "g"))?.length).toBe(1);
  });

  it("uses the block alone when there is no prior prose", () => {
    expect(applyRoadmapContext("", block)).toBe(block);
  });

  it("stripRoadmapContext removes a stale block but keeps prose", () => {
    const withBlock = applyRoadmapContext("Kept prose.", block);
    expect(stripRoadmapContext(withBlock)).toBe("Kept prose.");
  });

  it("a null block only strips any stale block", () => {
    const withBlock = applyRoadmapContext("Kept prose.", block);
    expect(applyRoadmapContext(withBlock, null)).toBe("Kept prose.");
  });
});
