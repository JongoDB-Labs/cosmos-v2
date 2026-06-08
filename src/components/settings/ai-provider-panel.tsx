"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, KeyRound, Plug, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { ClaudeSubscriptionConnect } from "./claude-subscription-panel";

/**
 * AI provider selector (Settings → AI). The org picks ONE active provider; the
 * egress chokepoint resolves credentials for it. THIN client: the API
 * (`/ai/provider`, `/ai/anthropic-key`, `/ai/openai-config`,
 * `/ai/claude-subscription/*`) is the source of truth — this just GET/POST/DELETEs.
 *
 * Three cards / a one-of-three radio group:
 *   - "Claude subscription" → the existing OAuth connect flow (claude-oauth).
 *   - "Anthropic API key"   → a password input + Save / Clear (anthropic).
 *   - "OpenAI-compatible"   → baseUrl + model + key inputs + Save / Clear (openai).
 *
 * Secrets are never echoed back — status carries `configured` booleans only.
 */

type ProviderKind = "claude-oauth" | "anthropic" | "openai";

interface ProviderStatus {
  provider: string;
  anthropic: { configured: boolean };
  openai: { configured: boolean; baseUrl?: string; model?: string };
  claudeOAuth: { connected: boolean; email?: string | null; expiresAt?: string | null };
}

export function AiProviderPanel({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("ai-provider");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      jsonFetch<ProviderStatus>(`/api/v1/orgs/${orgId}/ai/provider`),
  });

  const useProvider = useOrgMutation({
    mutationFn: (provider: ProviderKind) =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/provider`, {
        method: "POST",
        body: JSON.stringify({ provider }),
      }),
    invalidate: [["ai-provider"]],
    onSuccess: () => toast.success("Active AI provider updated."),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <LoadError
        title="Couldn't load AI provider settings"
        onRetry={() => refetch()}
      />
    );
  }

  const active = data.provider as ProviderKind;
  const setActive = (provider: ProviderKind) => useProvider.mutate(provider);
  const switching = useProvider.isPending;

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        Choose how this org&apos;s AI agent authenticates to a model. Exactly one
        provider is active at a time. Credentials are encrypted at rest and never
        shown again after saving.
      </p>

      <ProviderCard
        icon={Sparkles}
        title="Claude subscription"
        description="Run the agent on a connected Claude (Pro/Max) subscription."
        active={active === "claude-oauth"}
        configured={data.claudeOAuth.connected}
        onUse={() => setActive("claude-oauth")}
        canUse={data.claudeOAuth.connected}
        switching={switching}
        useDisabledHint="Connect a Claude subscription below first."
      >
        <ClaudeSubscriptionConnect orgId={orgId} />
      </ProviderCard>

      <AnthropicKeyCard
        orgId={orgId}
        active={active === "anthropic"}
        configured={data.anthropic.configured}
        onUse={() => setActive("anthropic")}
        switching={switching}
      />

      <OpenAiCard
        orgId={orgId}
        active={active === "openai"}
        configured={data.openai.configured}
        baseUrl={data.openai.baseUrl}
        model={data.openai.model}
        onUse={() => setActive("openai")}
        switching={switching}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Card chrome                                                                */
/* -------------------------------------------------------------------------- */

function ProviderCard({
  icon: Icon,
  title,
  description,
  active,
  configured,
  onUse,
  canUse = true,
  switching,
  useDisabledHint,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  active: boolean;
  configured: boolean;
  onUse: () => void;
  canUse?: boolean;
  switching: boolean;
  useDisabledHint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "rounded-lg border bg-card transition-colors" +
        (active ? " border-[var(--primary)] ring-1 ring-[var(--primary)]/40" : "")
      }
    >
      <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Icon className="size-4 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{title}</h3>
              {active ? <Badge variant="done">Active</Badge> : null}
              {configured ? (
                <Badge variant="neutral">Configured</Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {active ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-done-text,var(--status-done))]">
            <Check className="size-3.5" />
            In use
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!canUse || switching}
            title={!canUse ? useDisabledHint : undefined}
            onClick={onUse}
          >
            {switching ? <Loader2 className="size-4 animate-spin" /> : null}
            Use this provider
          </Button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Anthropic API key                                                          */
/* -------------------------------------------------------------------------- */

function AnthropicKeyCard({
  orgId,
  active,
  configured,
  onUse,
  switching,
}: {
  orgId: string;
  active: boolean;
  configured: boolean;
  onUse: () => void;
  switching: boolean;
}) {
  const [key, setKey] = useState("");

  const save = useOrgMutation({
    mutationFn: (apiKey: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/anthropic-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      }),
    invalidate: [["ai-provider"]],
    onSuccess: () => {
      toast.success("Anthropic API key saved.");
      setKey("");
    },
  });

  const clear = useOrgMutation({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/anthropic-key`, { method: "DELETE" }),
    invalidate: [["ai-provider"]],
    onSuccess: () => {
      toast.success("Anthropic API key cleared.");
      setKey("");
    },
  });

  const submit = () => {
    if (key.trim() && !save.isPending) save.mutate(key.trim());
  };

  return (
    <ProviderCard
      icon={KeyRound}
      title="Anthropic API key"
      description="Bring your own Anthropic API key (sk-ant-api…)."
      active={active}
      configured={configured}
      onUse={onUse}
      switching={switching}
    >
      <div className="space-y-3">
        <label
          htmlFor="anthropic-key"
          className="text-sm font-medium text-[var(--text)]"
        >
          API key
        </label>
        <p className="text-xs text-[var(--text-muted)]">
          {configured
            ? "A key is stored. Enter a new one to replace it, or clear it."
            : "Paste your Anthropic API key. It is encrypted at rest and never shown again."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="anthropic-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? "•••• stored ••••" : "sk-ant-api…"}
            autoComplete="off"
            spellCheck={false}
            className="max-w-sm"
            disabled={save.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <Button disabled={!key.trim() || save.isPending} onClick={submit}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
          {configured ? (
            <Button
              variant="destructive"
              disabled={clear.isPending}
              onClick={() => clear.mutate(undefined)}
            >
              {clear.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    </ProviderCard>
  );
}

/* -------------------------------------------------------------------------- */
/*  OpenAI-compatible                                                          */
/* -------------------------------------------------------------------------- */

function OpenAiCard({
  orgId,
  active,
  configured,
  baseUrl,
  model,
  onUse,
  switching,
}: {
  orgId: string;
  active: boolean;
  configured: boolean;
  baseUrl?: string;
  model?: string;
  onUse: () => void;
  switching: boolean;
}) {
  const [baseUrlInput, setBaseUrlInput] = useState(baseUrl ?? "");
  const [modelInput, setModelInput] = useState(model ?? "");
  const [keyInput, setKeyInput] = useState("");

  const save = useOrgMutation({
    mutationFn: (body: { apiKey: string; baseUrl: string; model: string }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/openai-config`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidate: [["ai-provider"]],
    onSuccess: () => {
      toast.success("OpenAI-compatible provider saved.");
      setKeyInput("");
    },
  });

  const clear = useOrgMutation({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/openai-config`, { method: "DELETE" }),
    invalidate: [["ai-provider"]],
    onSuccess: () => {
      toast.success("OpenAI-compatible provider cleared.");
      setBaseUrlInput("");
      setModelInput("");
      setKeyInput("");
    },
  });

  const canSave =
    baseUrlInput.trim().length > 0 &&
    modelInput.trim().length > 0 &&
    keyInput.trim().length > 0 &&
    !save.isPending;

  const submit = () => {
    if (canSave) {
      save.mutate({
        apiKey: keyInput.trim(),
        baseUrl: baseUrlInput.trim(),
        model: modelInput.trim(),
      });
    }
  };

  return (
    <ProviderCard
      icon={Plug}
      title="OpenAI-compatible"
      description="Point the agent at any OpenAI-compatible endpoint (OpenAI, a gateway, or self-hosted)."
      active={active}
      configured={configured}
      onUse={onUse}
      switching={switching}
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label
              htmlFor="openai-base-url"
              className="text-sm font-medium text-[var(--text)]"
            >
              Base URL
            </label>
            <Input
              id="openai-base-url"
              type="url"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              spellCheck={false}
              disabled={save.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="openai-model"
              className="text-sm font-medium text-[var(--text)]"
            >
              Model
            </label>
            <Input
              id="openai-model"
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
              spellCheck={false}
              disabled={save.isPending}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="openai-key"
            className="text-sm font-medium text-[var(--text)]"
          >
            API key
          </label>
          <p className="text-xs text-[var(--text-muted)]">
            {configured
              ? "A key is stored. Re-enter the key (with base URL + model) to update."
              : "Encrypted at rest and never shown again after saving."}
          </p>
          <Input
            id="openai-key"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={configured ? "•••• stored ••••" : "sk-…"}
            autoComplete="off"
            spellCheck={false}
            className="max-w-sm"
            disabled={save.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!canSave} onClick={submit}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
          {configured ? (
            <Button
              variant="destructive"
              disabled={clear.isPending}
              onClick={() => clear.mutate(undefined)}
            >
              {clear.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    </ProviderCard>
  );
}
