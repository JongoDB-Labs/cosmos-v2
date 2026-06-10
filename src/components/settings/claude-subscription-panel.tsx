"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Claude subscription connect (AI / Model settings) — THIN client surface. The API owns the
 * OAuth-ish flow: this panel GETs status, POSTs initiate (to get the Claude login URL), POSTs
 * exchange (to redeem the manually-pasted code), and POSTs disconnect.
 *
 * Manual paste-code flow — there is NO redirect back to our app. The user clicks "Connect",
 * we open claude.com in a new tab, they log into their Pro/Max subscription, authorize, and
 * Claude shows them a code. They copy it and paste it back here; we redeem it via exchange.
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

/**
 * Self-contained Claude-subscription panel — the inner connect flow wrapped in a
 * SectionCard. Kept for any surface that renders Claude on its own.
 */
export function ClaudeSubscriptionPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={Sparkles}
      title="Claude subscription"
      description="Connect a Claude (Pro/Max) subscription to power this org's AI agent."
    >
      <ClaudeSubscriptionConnect orgId={orgId} />
    </SectionCard>
  );
}

/**
 * The Claude-subscription CONNECT flow without its own card chrome, so it can be
 * embedded inside the multi-provider selector's "Claude subscription" card. THIN:
 * GETs status, POSTs initiate / exchange / disconnect.
 */
export function ClaudeSubscriptionConnect({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("claude-subscription");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      jsonFetch<StatusResponse>(
        `/api/v1/orgs/${orgId}/ai/claude-subscription/status`,
      ),
  });

  // Step-2 UI is revealed only after a successful initiate. Holds the pasted code.
  const [showExchange, setShowExchange] = useState(false);
  const [code, setCode] = useState("");

  const initiate = useOrgMutation({
    mutationFn: () =>
      jsonFetch<InitiateResponse>(
        `/api/v1/orgs/${orgId}/ai/claude-subscription/initiate`,
        { method: "POST" },
      ),
    onSuccess: (res) => {
      // Open Claude's login/authorize page in a new tab; reveal the paste-code step.
      if (res?.url) window.open(res.url, "_blank", "noopener,noreferrer");
      setShowExchange(true);
    },
  });

  const exchange = useOrgMutation({
    mutationFn: (c: string) =>
      jsonFetch<ExchangeResponse>(
        `/api/v1/orgs/${orgId}/ai/claude-subscription/exchange`,
        { method: "POST", body: JSON.stringify({ code: c }) },
      ),
    invalidate: [["claude-subscription"]],
    // Own onError so the exchange failure shows inline-friendly text via toast.
    onError: (err) => notifyError(err, "Couldn't connect. Check the code and try again."),
    onSuccess: (res) => {
      // The route returns 200 with { success:false, error } for a bad/expired code.
      if (!res?.success) {
        toast.error(res?.error?.trim() || "That code didn't work. Try again.");
        return;
      }
      toast.success(
        res.email
          ? `Connected as ${res.email}.`
          : "Claude subscription connected.",
      );
      setShowExchange(false);
      setCode("");
    },
  });

  const disconnect = useOrgMutation({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/ai/claude-subscription/disconnect`, {
        method: "POST",
      }),
    invalidate: [["claude-subscription"]],
    onSuccess: () => {
      toast.success("Claude subscription disconnected.");
      setShowExchange(false);
      setCode("");
    },
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
        title="Couldn't load Claude subscription status"
        onRetry={() => refetch()}
      />
    );
  }

  const expiry = formatExpiry(data.expiresAt);

  // ── Connected ──────────────────────────────────────────────────────────────
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
        <ConfirmButton
          variant="destructive"
          pending={disconnect.isPending}
          confirmLabel="Confirm disconnect"
          onConfirm={() => disconnect.mutate(undefined)}
        >
          Disconnect
        </ConfirmButton>
      </div>
    );
  }

  // ── Not connected — connect flow ─────────────────────────────────────────────
  return (
    <div className="space-y-4">
        <p className="text-sm text-[var(--text-muted)]">
          Click <span className="font-medium text-[var(--text)]">Connect</span>{" "}
          to open Claude in a new tab. Log into your Claude (Pro or Max)
          subscription, authorize access, then copy the code Claude shows you and
          paste it back here to finish connecting.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={initiate.isPending}
            onClick={() => initiate.mutate(undefined)}
          >
            {initiate.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            Connect Claude subscription
          </Button>
          {showExchange ? (
            <span className="text-xs text-[var(--text-muted)]">
              Didn&apos;t open?{" "}
              <button
                type="button"
                className="font-medium text-[var(--primary)] underline-offset-2 hover:underline"
                onClick={() => initiate.mutate(undefined)}
              >
                Open Claude again
              </button>
            </span>
          ) : null}
        </div>

        {showExchange ? (
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <label
              htmlFor="claude-auth-code"
              className="text-sm font-medium text-[var(--text)]"
            >
              Paste the code from Claude
            </label>
            <p className="text-xs text-[var(--text-muted)]">
              After authorizing, Claude shows a one-time code. Paste it below to
              finish connecting this org.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="claude-auth-code"
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
