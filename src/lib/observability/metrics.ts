// src/lib/observability/metrics.ts — the SI-4 metric contract (OBSERVE-ONLY).
//
// Custom OpenTelemetry instruments for the CUI-blind egress chokepoint + the in-boundary
// classifier. These exist purely to make the gov-critical signals visible (chokepoint
// erroring / fail-closed volume, classifier-down, withhold rate). They MUST:
//   - NEVER carry CUI / PII / message content — only counts, enums, hashes, latency.
//   - NEVER throw or block (fire-and-forget): a metric emit failure must not crash or
//     delay an agent turn. This holds with OR without an SDK registered, because
//     `metrics.getMeter()` returns the API's no-op Meter when no provider is set, and
//     no-op instruments accept .add()/.record() and do nothing.
//
// The Prometheus exporter renders dots->underscores and appends `_total` to counters:
//   cosmos.egress.decisions     -> cosmos_egress_decisions_total
//   cosmos.egress.errors        -> cosmos_egress_errors_total
//   cosmos.classifier.invocations -> cosmos_classifier_invocations_total
//   cosmos.classifier.errors    -> cosmos_classifier_errors_total
//   cosmos.classifier.latency   -> cosmos_classifier_latency_milliseconds (histogram)

import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

// A single named Meter for the whole app. getMeter() never throws and returns the
// no-op meter when no MeterProvider is registered (e.g. unit tests, or when the OTLP
// endpoint is unset). Instruments are created once (module singletons).
const meter = metrics.getMeter("cosmos");

const egressDecisions: Counter = meter.createCounter("cosmos.egress.decisions", {
  description: "Egress gate decisions crossing the model boundary (counts only — never content).",
});

const egressErrors: Counter = meter.createCounter("cosmos.egress.errors", {
  description: "Egress chokepoint errors / fail-closed-by-exception. The chokepoint-erroring alert signal.",
});

const classifierInvocations: Counter = meter.createCounter("cosmos.classifier.invocations", {
  description: "In-boundary CUI classifier invocations by result (allow|deny|error).",
});

const classifierErrors: Counter = meter.createCounter("cosmos.classifier.errors", {
  description: "In-boundary classifier errors (model unavailable / threw). The classifier-down alert signal.",
});

const classifierLatency: Histogram = meter.createHistogram("cosmos.classifier.latency", {
  description: "In-boundary classifier latency.",
  unit: "ms",
});

/**
 * Record one egress gate decision. Attributes are LOW-CARDINALITY ENUMS only — never the
 * conversationId, content, or hash (those live in the audit table, not in metric labels).
 */
export function recordEgressDecision(d: {
  exposed: boolean;
  decidedBy: string;
  tenantClass: string;
}): void {
  try {
    egressDecisions.add(1, {
      exposed: d.exposed ? "true" : "false",
      decided_by: d.decidedBy,
      tenant_class: d.tenantClass,
    });
  } catch {
    // Fire-and-forget: instrumentation must never affect the turn. Swallow.
  }
}

/** Record an egress chokepoint error (the turn threw / failed closed by exception). */
export function recordEgressError(stage: string): void {
  try {
    egressErrors.add(1, { stage });
  } catch {
    /* fire-and-forget */
  }
}

/**
 * Record one classifier invocation: its result enum + latency. `result` is allow|deny;
 * use recordClassifierError() for the error path (it also bumps the invocations{error}).
 */
export function recordClassifier(d: { result: "allow" | "deny"; latencyMs: number }): void {
  try {
    classifierInvocations.add(1, { result: d.result });
    classifierLatency.record(d.latencyMs);
  } catch {
    /* fire-and-forget */
  }
}

/**
 * Record a classifier error (the in-boundary classifier threw / the model is unavailable).
 * Bumps BOTH the dedicated error counter (the ClassifierDown alert signal) and
 * invocations{result="error"} so the result breakdown stays complete.
 */
export function recordClassifierError(): void {
  try {
    classifierErrors.add(1);
    classifierInvocations.add(1, { result: "error" });
  } catch {
    /* fire-and-forget */
  }
}
