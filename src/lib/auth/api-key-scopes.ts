/**
 * Client-safe API-key scope vocabulary — PURE constants, no server-only imports
 * (no prisma/crypto/session), so a client component (the Settings panel) can import
 * it without dragging the server auth graph into the browser bundle. The server lib
 * (`api-key.ts`) and the routes import these from here too.
 */
export const API_KEY_SCOPES = ["read", "items:write", "documents:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
