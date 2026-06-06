"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * Reports Core Web Vitals (LCP, CLS, INP, FCP, TTFB) to /api/v1/metrics/vitals.
 * Mounted once in the dashboard shell. Uses `navigator.sendBeacon` when
 * available so reports flush even when the page is unloading.
 */
export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    const payload = JSON.stringify({
      name: metric.name,
      id: metric.id,
      value: metric.value,
      rating:
        "rating" in metric ? (metric as { rating: string }).rating : undefined,
      delta: metric.delta,
      navigationType: metric.navigationType,
      url: window.location.pathname,
      ts: Date.now(),
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/v1/metrics/vitals",
          new Blob([payload], { type: "application/json" }),
        );
      } else {
        void fetch("/api/v1/metrics/vitals", {
          method: "POST",
          body: payload,
          headers: { "Content-Type": "application/json" },
          keepalive: true,
        }).catch(() => undefined);
      }
    } catch {
      // never throw from telemetry
    }
  });

  return null;
}
