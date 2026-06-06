// instrumentation.node.ts — Node-runtime OTel setup (imported by instrumentation.ts).
//
// Uses @vercel/otel's registerOTel() (the Next.js-documented path; pure OTLP, NO Vercel
// SaaS). It auto-configures traces + the fetch/http server instrumentation and honors
// OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_PROTOCOL.
//
// NOTE: @vercel/otel only stands up a MeterProvider when `metricReaders` (or `views`) is
// passed — it does NOT auto-wire metric export from env alone. So we add an explicit
// PeriodicExportingMetricReader backed by the OTLP/proto metric exporter, gated on a
// configured endpoint. Without an endpoint we register NO reader, so the global Meter
// stays the API no-op (our metric helpers still never throw — see metrics.ts).
//
// This module is dynamically imported only in the Node runtime (see instrumentation.ts),
// so the metric SDK never loads in the edge runtime.

import { registerOTel } from "@vercel/otel";
import { PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";

function metricReaders(): MetricReader[] | undefined {
  // Only stand up a real exporter when an OTLP endpoint is configured. When absent the
  // app still runs (the global Meter is the no-op API meter).
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;

  // The OTLP/proto exporter derives its URL from OTEL_EXPORTER_OTLP_(METRICS_)ENDPOINT
  // and appends /v1/metrics for the base endpoint. Export failures (collector down) are
  // logged + retried by the SDK — never fatal (fire-and-forget; the turn is never blocked).
  const exporter = new OTLPMetricExporter();
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS ?? "10000"),
  });
  return [reader];
}

registerOTel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "cosmos-v2",
  metricReaders: metricReaders(),
});
