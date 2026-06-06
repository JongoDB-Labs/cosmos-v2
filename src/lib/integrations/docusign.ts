/**
 * DocuSign envelope workflow (JWT Grant authentication).
 *
 * Ported / adapted from okr-dashboard/server/docusign.js.
 * The okr-dashboard variant happened to use BoldSign; this cosmos port
 * implements the DocuSign eSignature REST API directly via fetch + Node's
 * built-in `crypto` (RSA-SHA256 JWT signing) so we don't pull in the SDK.
 *
 * Configuration (env):
 *   DOCUSIGN_ACCOUNT_ID      - target account GUID
 *   DOCUSIGN_USER_ID         - impersonated user GUID (JWT `sub`)
 *   DOCUSIGN_INTEGRATION_KEY - integration key / client_id (JWT `iss`)
 *   DOCUSIGN_PRIVATE_KEY     - RSA private key (PKCS#8 or PKCS#1 PEM)
 *   DOCUSIGN_BASE_URL        - e.g. https://demo.docusign.net/restapi
 *
 * If any are missing the helper throws "DocuSign env vars not configured".
 */
import { createSign } from "node:crypto";

type DocuSignConfig = {
  accountId: string;
  userId: string;
  integrationKey: string;
  privateKey: string;
  baseUrl: string;
};

/** OAuth host inferred from the REST base URL. */
function oauthHost(baseUrl: string): string {
  // demo.docusign.net -> account-d.docusign.com
  // www.docusign.net  -> account.docusign.com
  try {
    const host = new URL(baseUrl).hostname;
    if (host.includes("demo") || host.includes("stage")) {
      return "account-d.docusign.com";
    }
    return "account.docusign.com";
  } catch {
    return "account-d.docusign.com";
  }
}

function getConfig(): DocuSignConfig {
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const userId = process.env.DOCUSIGN_USER_ID;
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const privateKey = process.env.DOCUSIGN_PRIVATE_KEY;
  const baseUrl = process.env.DOCUSIGN_BASE_URL;

  if (!accountId || !userId || !integrationKey || !privateKey || !baseUrl) {
    throw new Error("DocuSign env vars not configured");
  }
  return {
    accountId,
    userId,
    integrationKey,
    // Allow `\n` escapes in env vars (common when storing PEM in single line)
    privateKey: privateKey.replace(/\\n/g, "\n"),
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Build and sign a DocuSign JWT assertion. */
function signJwtAssertion(cfg: DocuSignConfig): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: cfg.integrationKey,
    sub: cfg.userId,
    iat: now,
    exp: now + 3600,
    aud: oauthHost(cfg.baseUrl),
    scope: "signature impersonation",
  };

  const headerSeg = base64UrlEncode(JSON.stringify(header));
  const payloadSeg = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(cfg.privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// Simple in-memory access-token cache (per-process).
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: DocuSignConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }

  const assertion = signJwtAssertion(cfg);
  const url = `https://${oauthHost(cfg.baseUrl)}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign OAuth ${res.status}: ${text.substring(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return json.access_token;
}

async function docusignRequest<T = unknown>(
  cfg: DocuSignConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken(cfg);
  const url = `${cfg.baseUrl}/v2.1/accounts/${cfg.accountId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `DocuSign API ${res.status} ${method} ${path}: ${text.substring(0, 300)}`
    );
  }
  // 204 / empty
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

export type CreateEnvelopeInput = {
  contractId: string;
  signerEmail: string;
  signerName: string;
  documentBase64: string;
  documentName: string;
};

/**
 * Create and send a DocuSign envelope with a single signer + one signature
 * tab on page 1.
 * Returns the envelopeId.
 */
export async function createEnvelope(input: CreateEnvelopeInput): Promise<string> {
  const cfg = getConfig();

  // Determine file extension for DocuSign's `fileExtension` field.
  const ext = (input.documentName.split(".").pop() || "pdf").toLowerCase();

  const envelopeDefinition = {
    emailSubject: `Please sign: ${input.documentName}`,
    emailBlurb: `Please review and sign this document.`,
    status: "sent",
    documents: [
      {
        documentBase64: input.documentBase64,
        name: input.documentName,
        fileExtension: ext,
        documentId: "1",
      },
    ],
    recipients: {
      signers: [
        {
          email: input.signerEmail,
          name: input.signerName,
          recipientId: "1",
          routingOrder: "1",
          tabs: {
            signHereTabs: [
              {
                anchorString: "/sig1/",
                anchorIgnoreIfNotPresent: "true",
                anchorUnits: "pixels",
                anchorXOffset: "0",
                anchorYOffset: "0",
                // Fallback fixed placement if no anchor present
                pageNumber: "1",
                documentId: "1",
                xPosition: "100",
                yPosition: "100",
              },
            ],
          },
        },
      ],
    },
    customFields: {
      textCustomFields: [
        {
          name: "contractId",
          value: input.contractId,
          required: "false",
          show: "false",
        },
      ],
    },
  };

  const res = await docusignRequest<{ envelopeId: string }>(
    cfg,
    "POST",
    "/envelopes",
    envelopeDefinition
  );
  if (!res?.envelopeId) {
    throw new Error("DocuSign envelope creation returned no envelopeId");
  }
  return res.envelopeId;
}

export type EnvelopeStatus =
  | "sent"
  | "delivered"
  | "completed"
  | "declined"
  | "voided";

/**
 * Fetch the current status of an envelope. Returned values are normalised to
 * one of: sent | delivered | completed | declined | voided.
 * Anything unrecognised is returned verbatim.
 */
export async function getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
  const cfg = getConfig();
  const res = await docusignRequest<{ status?: string }>(
    cfg,
    "GET",
    `/envelopes/${encodeURIComponent(envelopeId)}`
  );
  const status = (res?.status || "").toLowerCase();
  // DocuSign emits more granular statuses (created, voided, signed,
  // delivered, completed, declined, sent). Map "signed" -> "completed"
  // so callers get a stable shape.
  if (status === "signed") return "completed";
  return (status as EnvelopeStatus) || "sent";
}
