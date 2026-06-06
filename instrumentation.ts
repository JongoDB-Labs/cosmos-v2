// instrumentation.ts (repo root) — Next.js server-startup hook (SI-4 / 800-171 3.14.6-3.14.7).
//
// OBSERVE-ONLY. This wires OpenTelemetry so the app exports traces + metrics to an
// in-boundary OTel Collector over OTLP. It NEVER changes a gate / fail-closed / withhold
// decision and NEVER emits CUI/PII — only counts/enums/hashes/latency (see
// src/lib/observability/metrics.ts). Export is fire-and-forget: when the collector is
// absent/unreachable the OTLP exporter logs + retries and the app keeps running.
//
// Endpoint/protocol come from standard OTel env vars so this talks to ANY OTLP backend
// (our compose collector, or a gov enterprise OTel/SIEM) with no code change:
//   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://otel-collector:4318
//   OTEL_EXPORTER_OTLP_PROTOCOL   http/protobuf
//   OTEL_SERVICE_NAME             cosmos-v2 (defaulted below)

export async function register(): Promise<void> {
  // Next.js calls register() in every runtime (nodejs + edge). The OTLP metric
  // reader + node instrumentation only make sense in the Node server runtime, so
  // gate the heavy setup there. The edge runtime gets the default @vercel/otel
  // trace wiring (no-op when no endpoint is configured).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
