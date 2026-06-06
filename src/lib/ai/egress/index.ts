// src/lib/ai/egress/index.ts
import { callModel, type CallModelRequest, type ModelMessage, type ModelTool, type ModelTurnResult } from "./provider";
import { projectForModel } from "./gate";
import { logEgressDecision } from "./audit";
import { effectiveCeiling } from "@/lib/classification/effective";
import { classifyLikelyCui } from "@/lib/classification/classifier";
import { recordEgressError, recordClassifier, recordClassifierError } from "@/lib/observability/metrics";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { EgressContext } from "./types";

// OBSERVE-ONLY tracer for the chokepoint. Spans carry only enums/counts (tenant_class,
// turn) — never message content. trace.getTracer() never throws and returns a no-op
// tracer when no SDK is registered.
const tracer = trace.getTracer("cosmos.egress");

export type { EgressContext, EgressDecision, TenantClass, ValueKind } from "./types";
export { isWithheld } from "./types";
export { projectForModel, sha256Hex } from "./gate";
export { projectStructural, projectResult, entityTypeForTool, augmentWithHandles, HANDLEABLE_FIELDS } from "./projection";
export { mintHandle, resolveHandle, resolveHandlesDeep, isHandle } from "./handles";
export { logEgressDecision } from "./audit";
export type { ModelMessage, ModelTool, ModelToolUse, ModelTurnResult } from "./provider";

/** v1 ToolDefinition already uses Anthropic's `input_schema` shape — map 1:1. */
export function toModelTools(tools: { name: string; description: string; input_schema: Record<string, unknown> }[]): ModelTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export interface RunModelTurnInput {
  ctx: EgressContext;
  system: string;
  /**
   * The native conversation. The agent loop projects each tool_result through the
   * gate BEFORE appending it here (tool_result bodies are already model-safe).
   * String-content message bodies (initial user prompt + rendered history /
   * channel-context blobs) are marking-gated inside `runModelTurn` — any body
   * containing a controlled marking is substituted with "[withheld: controlled
   * marking]" before the request reaches the provider.
   */
  messages: ModelMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens?: number;
  onTextDelta?: (delta: string) => void;
}

/**
 * The single chokepoint to the model: the ONLY function that calls
 * `provider.callModel` (enforced by ESLint + the single-path arch test).
 *
 * Phase 2c: resolves the org's effective ceiling, projects the SYSTEM prompt and
 * EVERY model-bound message body (initial prompt + any rendered history /
 * channel-context blob) through the gate, substituting the projected value. A
 * value containing a controlled marking (CUI, FOUO, NOFORN, …) is withheld for
 * BOTH tenants — deterministic "detector, not declassifier" tripwire. The agent
 * loop projects every tool_result body upstream before it re-enters `messages`, so
 * tool_result blocks (array content) are already gated; this map skips them.
 *
 * TODO(phase-2c-remaining): per-message CEILING-BASED withholding of UNMARKED CUI
 * still needs the in-boundary ML classifier + structured conversation history.
 * This slice closes MARKED CUI deterministically; unmarked CUI in free-text
 * prompts/history still flows until the classifier ships.
 */
export async function runModelTurn(input: RunModelTurnInput): Promise<ModelTurnResult> {
  // OBSERVE-ONLY span around the whole chokepoint turn. The span carries ONLY enums/counts
  // (tenant_class, turn) — never message content. On a thrown chokepoint error we record
  // `cosmos.egress.errors{stage}` and mark the span ERROR, then RETHROW: the existing
  // fail-closed behavior is preserved EXACTLY (a rejected turn = nothing reaches the model).
  return tracer.startActiveSpan("egress.runModelTurn", async (span) => {
    span.setAttribute("cosmos.tenant_class", input.ctx.tenantClass);
    span.setAttribute("cosmos.turn", input.ctx.turn);
    // Coarse stage label for the egress-error metric (an ENUM, never content). Advanced as
    // the turn progresses so a thrown error is attributed to the stage it failed in.
    let stage = "ceiling";
    try {
      // Resolve the org's effective ceiling once. System/user are non-data (the gate
      // exposes them regardless of ceiling), but the decision record carries it as
      // audit evidence. The marking tripwire fires if the value itself contains a
      // controlled marking, regardless of the ceiling.
      const orgCeiling = await effectiveCeiling(input.ctx.orgId);
      stage = "project";

      const sys = projectForModel(input.system, input.ctx, { valueKind: "system", ceiling: orgCeiling });
      logEgressDecision(sys.decision);

      // Project every string-content message body (initial prompt + any rendered
      // history / channel-context blob). tool_use / tool_result blocks have array
      // content — skip them (already gated by the agent loop upstream).
      const gatedMessages = await Promise.all(input.messages.map(async (m) => {
        if (typeof m.content !== "string") return m; // tool_use/tool_result arrays already projected by the loop
        const p = projectForModel(m.content, input.ctx, { valueKind: "user", ceiling: orgCeiling });
        logEgressDecision(p.decision);
        let body = typeof p.modelValue === "string" ? p.modelValue : "[withheld: controlled marking]";
        // Gov-only async classifier tripwire (detector-only): catches unmarked CUI in prompt/history.
        // Only fires when the marking-DLP gate left the body EXPOSED (allow→deny; never loosens a withhold).
        if (input.ctx.tenantClass === "gov" && p.decision.exposed) {
          // OBSERVE-ONLY instrumentation of the classifier. The control flow is UNCHANGED:
          // a true result still withholds (allow→deny); a THROW still propagates (the turn
          // rejects → fails closed — unmarked CUI never reaches the model because the
          // classifier was down). We only record metrics around it; we never swallow.
          const t0 = Date.now();
          let likely: boolean;
          try {
            likely = await classifyLikelyCui(m.content);
          } catch (e) {
            recordClassifierError(); // the classifier-down alert signal
            stage = "classifier";
            throw e; // preserve fail-closed semantics EXACTLY — do not swallow
          }
          recordClassifier({ result: likely ? "deny" : "allow", latencyMs: Date.now() - t0 });
          if (likely) {
            body = "[withheld: classifier]";
            logEgressDecision({ ...p.decision, exposed: false, withheldCount: 1, decidedBy: "classification" });
          }
        }
        return { ...m, content: body };
      }));

      const req: CallModelRequest = {
        system: typeof sys.modelValue === "string" ? sys.modelValue : "[withheld: controlled marking]",
        messages: gatedMessages,
        tools: input.tools,
        model: input.model,
        maxTokens: input.maxTokens,
        onTextDelta: input.onTextDelta,
      };
      stage = "model";
      const result = await callModel(req);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      // The chokepoint threw / failed closed by exception. Emit the error signal, mark
      // the span, then RETHROW — never alter the fail-closed outcome.
      recordEgressError(stage);
      // Record ONLY the exception TYPE (name) on the span — never the message or
      // stacktrace, which a future provider/validation error could interpolate request
      // content into. Keeps "no CUI/PII in telemetry" unconditional.
      span.recordException({ name: (err as Error)?.name ?? "Error" });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
