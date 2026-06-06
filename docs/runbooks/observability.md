# Observability runbook (SI-4 / 800-171 3.14.6–3.14.7)

In-boundary, all-OSS continuous monitoring for the CUI-blind egress chokepoint. The app
is instrumented with OpenTelemetry and exports **traces + metrics** over OTLP to an
in-boundary OTel Collector, which fans metrics out to Prometheus and traces to Jaeger;
Grafana visualizes both. Prometheus holds the alert rules.

> **OBSERVE-ONLY.** Instrumentation never changes a gate / fail-closed / withhold decision
> and never emits CUI/PII — only counts, enums, hashes, and latency. Telemetry emit is
> fire-and-forget: a metric/trace failure can never block or crash an agent turn. When the
> collector is absent the app still runs (export attempts log + retry, never fatal).

## Stack diagram

```
                      OTLP (http/protobuf, :4318, internal)
  cosmos app  ───────────────────────────────────────────►  otel-collector
  (instrumentation.ts                                          │   │
   @vercel/otel + custom Meter)                                │   │
                                                  metrics :8889│   │traces (OTLP → jaeger:4317)
                                                               ▼   ▼
                                            Prometheus  ◄── scrape    Jaeger (store + UI :16686)
                                            (:9090, alerts.yml)            ▲
                                                  │                        │
                                                  └──────► Grafana (:3009) ┘
                                                       (Prometheus + Jaeger datasources,
                                                        COSMOS dashboard)
```

All sidecars run under the `observability` compose profile (digest-pinned). Collector OTLP
ports are internal-only; only the human UIs are published (Grafana **3009**, Jaeger
**16686**, Prometheus **9090** — chosen free of the v1 stack on 8080 and v2 caddy on 8090).

## Bring it up / down

```bash
# base stack (no telemetry sidecars — stays lean):
sudo docker compose up -d

# WITH the observability stack:
sudo docker compose --profile observability up -d

# tear down (include the profile so its volumes are removed):
sudo docker compose --profile observability down -v
```

Set `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` in `.env` (placeholders in
`.env.example`; never commit real creds). Grafana: `http://localhost:3009`.

## The metric contract

Emitted via a `@opentelemetry/api` Meter (`metrics.getMeter("cosmos")`) in
`src/lib/observability/metrics.ts`. The Prometheus exporter renders dots→underscores and
appends `_total` to counters.

| Instrument | Prometheus name | Attributes / labels | Meaning |
|---|---|---|---|
| `cosmos.egress.decisions` (Counter) | `cosmos_egress_decisions_total` | `exposed`(true/false), `decided_by`, `tenant_class` | every gate decision crossing the model boundary (withhold-rate + fail-closed volume derive from this) |
| `cosmos.egress.errors` (Counter) | `cosmos_egress_errors_total` | `stage` | chokepoint threw / failed closed by exception |
| `cosmos.classifier.invocations` (Counter) | `cosmos_classifier_invocations_total` | `result`(allow/deny/error) | in-boundary classifier calls |
| `cosmos.classifier.errors` (Counter) | `cosmos_classifier_errors_total` | — | classifier threw / model unavailable |
| `cosmos.classifier.latency` (Histogram, ms) | `cosmos_classifier_latency_milliseconds_*` | — | classifier latency |
| HTTP server requests | (TRACES, not a Prometheus histogram) | `http_route` on the span | per-route latency/throughput. NOTE: in this Next.js standalone setup `@vercel/otel` records HTTP server requests as **spans** (visible in Jaeger as `GET /api/health`, `POST /api/v1/orgs/[orgId]/.../messages`), not as a Prometheus `http_server_*` histogram. Use Jaeger for per-route latency; the collector throughput panel covers volume. |
| Traces | — | span `egress.runModelTurn` (+ HTTP server spans) | per-turn trace in Jaeger (service `cosmos-v2`) — verified: `egress.runModelTurn` span present |

**Never** add message content / PII to a metric or span attribute — the egress decision
data model already carries only hashes/counts/enums; keep it that way.

## Alerts + first response

Rules live in `compose/observability/alerts.yml`; firing state at
`http://localhost:9090/api/v1/alerts` (or the Prometheus UI → Alerts).

| Alert | Severity | Expression | Meaning + first response |
|---|---|---|---|
| **EgressChokepointErroring** | critical | `increase(cosmos_egress_errors_total[5m]) > 0` | The chokepoint is throwing / failing closed by exception. Turns are NOT leaking (fail-closed is safe), but the agent path is degraded. Inspect the app logs and the `egress.runModelTurn` ERROR spans in Jaeger; check the `stage` label to localize (ceiling/project/classifier/model). |
| **ClassifierDown** | critical | `increase(cosmos_classifier_errors_total[5m]) > 0` | The in-boundary CUI classifier (the unmarked-CUI tripwire) is erroring / the embeddings model is unavailable. Gov turns that hit the classifier path **fail closed (withhold)** while it is down — no silent unmarked-CUI exposure — but the detector must be restored. Check the embeddings model / onnxruntime in the app container; confirm the baked MiniLM cache loaded. |
| **SidecarDown** | warning | `up == 0` (for 1m) | A scrape target (collector / prometheus / jaeger / grafana) is down or unreachable. Telemetry coverage is reduced. Check the named sidecar's container + healthcheck. |

## Why a classifier-down failure is the right behavior

The classifier is a **detector, not a declassifier**: callers use it to turn allow→deny,
never to expose more. Today a classifier throw propagates out of `runModelTurn` → the turn
rejects → the model is never called → unmarked CUI cannot egress. The `ClassifierDown`
metric makes that degraded state **visible** (the whole point of SI-4) without changing the
fail-closed control flow. Restoring the classifier restores the detector; it does not
affect safety while down.

## Degradation: collector absent

If the `observability` profile is not up (or the collector is unreachable), the app's OTLP
exporter logs + retries and continues serving — base `up` runs without the sidecars. No
gate behavior changes either way; telemetry is purely additive.

## Gov / enterprise backend

The app side is fixed: it speaks plain OTLP. To send telemetry to a gov enterprise
OTel/SIEM backend instead of (or in addition to) this in-boundary stack, change only
`OTEL_EXPORTER_OTLP_ENDPOINT` (and the collector's exporters in `otel-collector.yaml`) — no
application code changes. Full SIEM correlation / log aggregation (Loki, 3.3.5) and richer
per-endpoint health (blackbox-exporter) are documented follow-ons.
