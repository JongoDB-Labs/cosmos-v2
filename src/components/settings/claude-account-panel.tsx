"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * PERSONAL Claude subscription connect (account settings) — the per-user sibling
 * of {@link file://./claude-subscription-panel.tsx}. Hits the /api/v1/me routes
 * and is NOT org-scoped: connecting here makes the COSMOS Agent run on YOUR
 * personal Claude account wherever you are, taking precedence over the org's
 * credential (which remains the fallback). Same manual paste-code flow.
 */

interface StatusResponse {
  connected: boolean;
  email?: string;
  expiresAt?: string;
}
interface InitiateResponse {
  url: string;
}
interface ExchangeResponse {
  success: boolean;
  email?: string;
  error?: string;
}

const STATUS_KEY = ["me", "claude-subscription"] as const;

function formatExpiry(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ClaudeAccountPanel() {
  return (
    <SectionCard
      icon={Sparkles}
      title="Personal Claude subscription"
      description="Connect your own Claude (Pro/Max) account so the COSMOS Agent runs on it. Takes priority over the org's AI credential; your org's setting is the fallback."
    >
      <ClaudeAccountConnect />
    </SectionCard>
  );
}

function ClaudeAccountConnect() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () =>
      jsonFetch<StatusResponse>("/api/v1/me/ai/claude-subscription/status"),
  });

  const [showExchange, setShowExchange] = useState(false);
  const [code, setCode] = useState("");

  const initiate = useMutation({
    mutationFn: () =>
      jsonFetch<InitiateResponse>("/api/v1/me/ai/claude-subscription/initiate", {
        method: "POST",
      }),
    onSuccess: (res) => {
      if (res?.url) window.open(res.url, "_blank", "noopener,noreferrer");
      setShowExchange(true);
    },
    onError: (err) => notifyError(err, "Couldn't start the connect flow."),
  });

  const exchange = useMutation({
    mutationFn: (c: string) =>
      jsonFetch<ExchangeResponse>("/api/v1/me/ai/claude-subscription/exchange", {
        method: "POST",
        body: JSON.stringify({ code: c }),
      }),
    onError: (err) =>
      notifyError(err, "Couldn't connect. Check the code and try again."),
    onSuccess: (res) => {
      if (!res?.success) {
        toast.error(res?.error?.trim() || "That code didn't work. Try again.");
        return;
      }
      toast.success(
        res.email ? `Connected as ${res.email}.` : "Personal Claude connected.",
      );
      setShowExchange(false);
      setCode("");
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      jsonFetch("/api/v1/me/ai/claude-subscription/disconnect", {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Personal Claude disconnected.");
      setShowExchange(false);
      setCode("");
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => notifyError(err, "Couldn't disconnect."),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <LoadError
        title="Couldn't load your Claude connection"
        onRetry={() => refetch()}
      />
    );
  }

  const expiry = formatExpiry(data.expiresAt);

  if (data.connected) {
    return (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Badge variant="done">Connected</Badge>
            {data.email ? (
              <span className="text-sm font-medium text-[var(--text)]">
                {data.email}
              </span>
            ) : null}
          </div>
          <span className="text-xs text-[var(--text-muted)]">
            {expiry
              ? `Authorization valid until ${expiry}.`
              : "Authorization active."}
          </span>
        </div>
        <Button
          variant="destructive"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          {disconnect.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        Click <span className="font-medium text-[var(--text)]">Connect</span> to
        open Claude in a new tab. Log into your Claude (Pro or Max) subscription,
        authorize access, then copy the code Claude shows you and paste it back
        here.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={initiate.isPending} onClick={() => initiate.mutate()}>
          {initiate.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ExternalLink className="size-4" />
          )}
          Connect my Claude subscription
        </Button>
        {showExchange ? (
          <span className="text-xs text-[var(--text-muted)]">
            Didn&apos;t open?{" "}
            <button
              type="button"
              className="font-medium text-[var(--primary)] underline-offset-2 hover:underline"
              onClick={() => initiate.mutate()}
            >
              Open Claude again
            </button>
          </span>
        ) : null}
      </div>

      {showExchange ? (
        <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <label
            htmlFor="claude-account-code"
            className="text-sm font-medium text-[var(--text)]"
          >
            Paste the code from Claude
          </label>
          <p className="text-xs text-[var(--text-muted)]">
            After authorizing, Claude shows a one-time code. Paste it below to
            finish connecting your account.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="claude-account-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code here"
              autoComplete="off"
              spellCheck={false}
              className="max-w-xs"
              disabled={exchange.isPending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim() && !exchange.isPending) {
                  exchange.mutate(code.trim());
                }
              }}
            />
            <Button
              disabled={!code.trim() || exchange.isPending}
              onClick={() => exchange.mutate(code.trim())}
            >
              {exchange.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Finish connecting
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
