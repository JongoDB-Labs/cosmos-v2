"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/telemetry/error-report";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { scope: "global" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B0E1A",
          color: "#E5E7EB",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 480, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Something broke</h1>
          <p style={{ opacity: 0.7, marginBottom: 16, fontSize: 14 }}>
            The application crashed before it could render. The error has been
            reported.
          </p>
          {error.digest ? (
            <p style={{ opacity: 0.5, marginBottom: 16, fontSize: 12 }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid #374151",
              background: "#1F2937",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
