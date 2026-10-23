"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
// The package's JS doesn't import its own styles; without this it renders unstyled.
import "@scalar/api-reference-react/style.css";
import "./scalar-overrides.css";

/**
 * Scalar, configured for an instance that may be airgapped and whose users are
 * signed in (docs/design/2026-10-23-api-mcp-spikes.md §2):
 *
 *  - nothing leaves the origin: no fonts.scalar.com, no telemetry, no agent or
 *    MCP drawer (Scalar's hosted API), no proxy (same-origin needs none), and no
 *    "Open API Client" button (a link handing our spec URL to client.scalar.com);
 *  - try-it requests OMIT credentials. Scalar's default fetch sends the session
 *    cookie, which would authorize the call instead of the token on screen, so
 *    the docs would show behaviour no API client ever gets.
 *
 * Loaded only by /developers/reference, behind next/dynamic: it is megabytes
 * of JS the rest of the app must never pull in.
 */
export default function ApiReferenceClient({ spec, token }: { spec: object; token?: string }) {
  // Follow the app's theme: the `dark`/`light` class on <html>, else the OS.
  const html = document.documentElement.classList;
  const dark = html.contains("dark") || (!html.contains("light") && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <ApiReferenceReact
      configuration={{
        content: spec,
        withDefaultFonts: false,
        telemetry: false,
        agent: { disabled: true },
        mcp: { disabled: true },
        persistAuth: false,
        hideClientButton: true,
        hideDarkModeToggle: true,
        forceDarkModeState: dark ? "dark" : "light",
        fetch: (input, init) => fetch(input, { ...init, credentials: "omit" }),
        authentication: {
          preferredSecurityScheme: "bearerPat",
          ...(token && { securitySchemes: { bearerPat: { token } } }),
        },
      }}
    />
  );
}
