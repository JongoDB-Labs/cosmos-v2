import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";
import {
  getOrgClaudeToken,
  getClaudeSubscriptionStatus,
} from "@/lib/ai/claude-subscription";
import { getUserClaudeToken } from "@/lib/ai/user-claude-subscription";
import type { ModelCredential } from "@/lib/ai/egress/types";

/**
 * MULTI-PROVIDER per-org model auth — the single source of truth the egress
 * chokepoint consults to decide HOW to authenticate to a model for THIS org.
 *
 * The CUI-blind boundary is preserved: ONLY `src/lib/ai/egress/` ever calls
 * {@link resolveOrgModelCredential}, the resolved credential is passed by value
 * into the stateless `callModel`, and nothing here holds a resident model
 * session. We read the per-org `OrgAiSettings` row and return a plain
 * {@link ModelCredential} (or `undefined`); we never talk to a model ourselves.
 *
 * Provider selection (`OrgAiSettings.provider`) picks the auth path:
 *   - "claude-oauth" → Claude SUBSCRIPTION token (delegated to claude-subscription).
 *   - "anthropic"    → a per-org Anthropic API key (sealed in `anthropicApiKey`).
 *   - "openai"       → an OpenAI-COMPATIBLE endpoint (sealed key + baseUrl + model
 *                      in `openaiApiKey`). NOT the Anthropic SDK — the egress
 *                      provider speaks raw OpenAI Chat Completions for this kind.
 *
 * Secrets are SEALED with the cosmos vault (AES-256-GCM keyring) before they ever
 * touch the DB and live in the `Json?` columns — NO schema change is required:
 *   - anthropicApiKey: { sealed: <sealed-key> }
 *   - openaiApiKey:    { sealed: <sealed-key>, baseUrl: <str>, model: <str> }
 *
 * Unseal failures NEVER throw to the caller — a corrupt/rotated envelope degrades
 * to `undefined` (the egress layer then falls back to the env ANTHROPIC_API_KEY),
 * so a broken org credential can never widen egress or crash a turn.
 */

/* -------------------------------------------------------------------------- */
/*  Provider enum                                                              */
/* -------------------------------------------------------------------------- */

/** The provider modes stored in `OrgAiSettings.provider`. */
export type AiProvider = "claude-oauth" | "anthropic" | "openai";

/* -------------------------------------------------------------------------- */
/*  Sealed-JSON helpers (shape-shared with claude-subscription)                */
/* -------------------------------------------------------------------------- */

/** Anthropic-key column shape. */
type AnthropicKeyJson = { sealed: string };
/** OpenAI-compatible column shape (sealed key + endpoint config). */
type OpenAiKeyJson = { sealed: string; baseUrl: string; model: string };

function isSealedRecord(value: unknown): value is { sealed: unknown } {
  return typeof value === "object" && value !== null && "sealed" in value;
}

/** Open a `{ sealed }` Json value to plaintext, or null on absence/tamper. */
function unsealKey(value: unknown): string | null {
  if (isSealedRecord(value) && typeof value.sealed === "string") {
    try {
      return openSecret(value.sealed);
    } catch {
      return null; // corrupt/rotated/tampered → degrade, never throw
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Resolution — the EGRESS entry point                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the per-call {@link ModelCredential}, dispatching on the stored
 * provider. Returns `undefined` when nothing is configured (egress then falls
 * back to the env key) and TOLERATES any unseal error by returning `undefined`
 * — it NEVER throws to the caller.
 *
 * PRECEDENCE (FR: agent tied to the user's token, not org-wide): when `userId`
 * is supplied and that user has connected their PERSONAL Claude subscription,
 * it WINS — the agent runs on the requesting user's account. Otherwise we fall
 * back to the org's configured provider. The user path is OAuth-only (a personal
 * Claude subscription); per-org Anthropic/OpenAI keys remain org-scoped.
 *
 * This is the ONLY function the egress layer calls to learn how to authenticate;
 * adding the user source does NOT add a second egress path — resolution still
 * happens inside the one CUI-blind chokepoint, after withholding.
 */
export async function resolveOrgModelCredential(
  orgId: string,
  userId?: string,
): Promise<ModelCredential | undefined> {
  // 1. Prefer the requesting user's personal Claude subscription when present.
  if (userId) {
    let userToken: string | null = null;
    try {
      userToken = await getUserClaudeToken(userId);
    } catch {
      userToken = null; // a broken user credential degrades to the org path
    }
    if (userToken) return { kind: "oauth", token: userToken };
  }

  // 2. Fall back to the org's configured provider.
  let settings: {
    provider: string;
    anthropicApiKey: Prisma.JsonValue | null;
    openaiApiKey: Prisma.JsonValue | null;
  } | null;
  try {
    settings = await prisma.orgAiSettings.findUnique({
      where: { orgId },
      select: { provider: true, anthropicApiKey: true, openaiApiKey: true },
    });
  } catch {
    return undefined; // DB hiccup must never widen/break egress
  }

  if (!settings) return undefined;

  switch (settings.provider) {
    case "claude-oauth": {
      let token: string | null = null;
      try {
        token = await getOrgClaudeToken(orgId);
      } catch {
        return undefined;
      }
      if (!token) return undefined;
      return { kind: "oauth", token };
    }
    case "anthropic": {
      const apiKey = unsealKey(settings.anthropicApiKey);
      if (!apiKey) return undefined;
      return { kind: "apiKey", apiKey };
    }
    case "openai": {
      const value = settings.openaiApiKey;
      if (!isSealedRecord(value)) return undefined;
      const apiKey = unsealKey(value);
      if (!apiKey) return undefined;
      const cfg = value as Partial<OpenAiKeyJson>;
      if (typeof cfg.baseUrl !== "string" || typeof cfg.model !== "string") {
        return undefined; // incomplete config — degrade to env fallback
      }
      return {
        kind: "openai",
        baseURL: cfg.baseUrl,
        apiKey,
        model: cfg.model,
      };
    }
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Setters — each upserts the org row + records the actor                     */
/* -------------------------------------------------------------------------- */

/** Switch the org's ACTIVE provider without touching stored keys. */
export async function setActiveProvider(
  orgId: string,
  provider: AiProvider,
  updatedById: string,
): Promise<void> {
  await prisma.orgAiSettings.upsert({
    where: { orgId },
    create: { orgId, provider, updatedById },
    update: { provider, updatedById },
  });
}

/** Seal + store the per-org Anthropic API key and select the anthropic provider. */
export async function setAnthropicKey(
  orgId: string,
  key: string,
  updatedById: string,
): Promise<void> {
  const sealed: AnthropicKeyJson = { sealed: sealSecret(key) };
  await prisma.orgAiSettings.upsert({
    where: { orgId },
    create: {
      orgId,
      provider: "anthropic",
      anthropicApiKey: sealed,
      updatedById,
    },
    update: {
      provider: "anthropic",
      anthropicApiKey: sealed,
      updatedById,
    },
  });
}

/** Seal + store the OpenAI-compatible endpoint config and select the openai provider. */
export async function setOpenAiConfig(
  orgId: string,
  config: { apiKey: string; baseUrl: string; model: string },
  updatedById: string,
): Promise<void> {
  const sealed: OpenAiKeyJson = {
    sealed: sealSecret(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
  };
  await prisma.orgAiSettings.upsert({
    where: { orgId },
    create: {
      orgId,
      provider: "openai",
      openaiApiKey: sealed,
      updatedById,
    },
    update: {
      provider: "openai",
      openaiApiKey: sealed,
      updatedById,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Status — for the settings UI                                               */
/* -------------------------------------------------------------------------- */

export interface AiProviderStatus {
  provider: string;
  anthropic: { configured: boolean };
  openai: { configured: boolean; baseUrl?: string; model?: string };
  claudeOAuth: Awaited<ReturnType<typeof getClaudeSubscriptionStatus>>;
}

/**
 * Report which providers the org has configured + which is active. NEVER returns
 * a secret — only booleans + the non-secret OpenAI baseUrl/model echo.
 */
export async function getAiProviderStatus(
  orgId: string,
): Promise<AiProviderStatus> {
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
    select: { provider: true, anthropicApiKey: true, openaiApiKey: true },
  });

  const provider = settings?.provider ?? "anthropic";

  const anthropicConfigured = isSealedRecord(settings?.anthropicApiKey)
    && typeof (settings?.anthropicApiKey as { sealed: unknown }).sealed === "string";

  const openaiValue = settings?.openaiApiKey;
  const openaiConfigured =
    isSealedRecord(openaiValue) && typeof openaiValue.sealed === "string";
  const openaiCfg = openaiConfigured
    ? (openaiValue as Partial<OpenAiKeyJson>)
    : undefined;

  const claudeOAuth = await getClaudeSubscriptionStatus(orgId);

  return {
    provider,
    anthropic: { configured: anthropicConfigured },
    openai: {
      configured: openaiConfigured,
      baseUrl: openaiCfg?.baseUrl,
      model: openaiCfg?.model,
    },
    claudeOAuth,
  };
}
