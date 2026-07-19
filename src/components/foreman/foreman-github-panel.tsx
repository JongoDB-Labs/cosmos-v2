"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, KeyRound } from "lucide-react";
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
 * Foreman's GitHub PAT connect card — a sibling of ForemanClaudePanel. Connects
 * the fine-grained GitHub token Foreman uses to read pull requests for the AI
 * analysis + approval recommendation (and, going forward, its git/PR/merge ops).
 * THIN: GET status, POST connect (server validates + seals), DELETE disconnect
 * against /api/v1/orgs/:orgId/foreman/github.
 */
interface GithubStatus {
  connected: boolean;
  login?: string | null;
  source?: "org" | "deployment";
}

export function ForemanGithubPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={KeyRound}
      title="GitHub for Foreman"
      description="Connect the fine-grained GitHub token Foreman uses to read pull requests for AI analysis and approval recommendations."
    >
      <ForemanGithubConnect orgId={orgId} />
    </SectionCard>
  );
}

/** Inline setup directions — which token + which permissions. Kept in the UI so
 *  an admin never has to leave the panel to know exactly what to grant. */
function TokenDirections() {
  return (
    <details className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
      <summary className="cursor-pointer font-medium text-[var(--text)]">
        How to create the token & which permissions
      </summary>
      <div className="mt-2 space-y-2 text-[var(--text-muted)]">
        <p>
          In GitHub go to{" "}
          <span className="font-medium text-[var(--text)]">Settings → Developer settings → </span>
          <a
            href="https://github.com/settings/tokens?type=beta"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--primary)] underline-offset-2 hover:underline"
          >
            Fine-grained tokens
          </a>
          <span className="font-medium text-[var(--text)]"> → Generate new token</span>. Set the{" "}
          <span className="font-medium text-[var(--text)]">Resource owner</span> to the org that owns
          your repository and limit <span className="font-medium text-[var(--text)]">Repository access</span>{" "}
          to that one repository.
        </p>
        <p className="font-medium text-[var(--text)]">Repository permissions</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="font-medium text-[var(--text)]">Pull requests</span> — Read (required for AI
            analysis); Read and write if Foreman should open &amp; merge PRs.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Contents</span> — Read and write, so Foreman
            can commit, push branches, and merge.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Checks</span> — Read (optional; lets
            recommendations factor in CI results).
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Actions</span> — Read (optional), or Read and
            write if Foreman should cancel / re-run CI.
          </li>
        </ul>
        <p>
          Metadata (read) is added automatically. You do <span className="font-medium text-[var(--text)]">not</span>{" "}
          need Administration, Secrets, Environments, or Deployments. If the repository is owned by an
          organization, that org must allow fine-grained tokens (Settings → Third-party Access); otherwise a{" "}
          <span className="font-medium text-[var(--text)]">classic token</span> with the{" "}
          <span className="font-mono text-[var(--text)]">repo</span> scope also works.
        </p>
      </div>
    </details>
  );
}

export function ForemanGithubConnect({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-github");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<GithubStatus>(`/api/v1/orgs/${orgId}/foreman/github`),
  });
  const [token, setToken] = useState("");

  const connect = useOrgMutation({
    mutationFn: (t: string) =>
      jsonFetch<GithubStatus>(`/api/v1/orgs/${orgId}/foreman/github`, {
        method: "POST",
        body: JSON.stringify({ token: t }),
      }),
    invalidate: [["foreman-github"]],
    onError: (err) => notifyError(err, "Couldn't connect that token. Check it and try again."),
    onSuccess: (res) => {
      toast.success(res?.login ? `GitHub connected as ${res.login}.` : "GitHub token connected.");
      setToken("");
    },
  });

  const disconnect = useOrgMutation({
    mutationFn: () => jsonFetch(`/api/v1/orgs/${orgId}/foreman/github`, { method: "DELETE" }),
    invalidate: [["foreman-github"]],
    onSuccess: () => toast.success("GitHub token disconnected."),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError || !data) {
    return <LoadError title="Couldn't load Foreman's GitHub connection status" onRetry={() => refetch()} />;
  }

  if (data.connected) {
    return (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Badge variant="done">Connected</Badge>
            {data.login ? (
              <span className="text-sm font-medium text-[var(--text)]">{data.login}</span>
            ) : null}
          </div>
          <span className="text-xs text-[var(--text-muted)]">
            {data.source === "deployment"
              ? "Using a deployment-configured token (GITHUB_ANALYSIS_TOKEN). Connect an org token here to override it."
              : "Foreman uses this token to read pull requests for analysis."}
          </span>
        </div>
        {data.source !== "deployment" ? (
          <ConfirmButton
            variant="destructive"
            pending={disconnect.isPending}
            confirmLabel="Confirm disconnect"
            onConfirm={() => disconnect.mutate(undefined)}
          >
            Disconnect
          </ConfirmButton>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        Foreman uses this token to read pull requests for AI analysis and approval recommendations
        (and, as its automation expands, to push branches, open PRs, and merge). Paste a fine-grained,
        read-only token below — it is validated, stored encrypted, and never shown again.
      </p>
      <TokenDirections />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="github_pat_... or ghp_..."
          autoComplete="off"
          spellCheck={false}
          className="max-w-sm font-mono"
          disabled={connect.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim() && !connect.isPending) connect.mutate(token.trim());
          }}
        />
        <Button disabled={!token.trim() || connect.isPending} onClick={() => connect.mutate(token.trim())}>
          {connect.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Connect
        </Button>
      </div>
    </div>
  );
}
