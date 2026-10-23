"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Org { id: string; name: string }
interface Minted { token: string; orgId: string }

/** The test token: read-only, one hour, named so it's recognisable on the profile page. */
export const TEST_TOKEN = { name: "API docs try-it", scopes: ["read"], expiresIn: 3600 } as const;

/**
 * Above the reference: mint a short-lived read-only token for try-it, or paste
 * your own into the reference's Authentication section.
 *
 * Minting goes through POST /api/v1/me/tokens with the browser session (it is
 * a session-only operation); the token is then the only credential try-it
 * sends. Signed out (public docs), there are no orgs and the button gives way
 * to a sign-in hint.
 */
export function TryItTokenPanel({ onChange }: { onChange: (tryIt: { token?: string; orgId: string }) => void }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState<string>("");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "org" | null>(null);

  useEffect(() => {
    fetch("/api/v1/orgs")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Org[]) => {
        setOrgs(list);
        if (list[0]) {
          setOrgId(list[0].id);
          onChange({ orgId: list[0].id });
        }
      })
      .catch(() => setOrgs([]));
  }, [onChange]);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, ...TEST_TOKEN }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail ?? body.error ?? "Couldn't create a token");
      setMinted({ token: body.token, orgId });
      onChange({ token: body.token, orgId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create a token");
    } finally {
      setBusy(false);
    }
  }

  function copy(what: "token" | "org", text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  }

  const orgName = orgs?.find((o) => o.id === (minted?.orgId ?? orgId))?.name;

  return (
    <section
      aria-labelledby="try-it-heading"
      className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2 id="try-it-heading" className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <KeyRound className="h-4 w-4" aria-hidden /> Try it
      </h2>

      <p
        role="note"
        className="flex items-start gap-2 rounded-md bg-[var(--primary-tint)] p-2 text-xs text-[var(--text)]"
      >
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Requests sent from this page run against real data on this instance
          {orgName ? <> in <strong>{orgName}</strong></> : null}. A test token can only read; a token you paste
          can change real data. Your browser session is never sent.
        </span>
      </p>

      {orgs === null ? null : orgs.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Sign in to create a test token, or paste a token in the reference&apos;s Authentication section.
        </p>
      ) : minted ? (
        <div className="space-y-2 text-xs text-[var(--text)]">
          <p>
            A read-only token for <strong>{orgName}</strong> is filled in below. It expires in an hour and is shown
            only now; revoke it any time under Settings → Profile.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded bg-[var(--bg)] px-2 py-1" data-testid="try-it-token">
              {minted.token}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy("token", minted.token)}>
              {copied === "token" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy token
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[var(--text-muted)]">Organization id for <code>{"{orgId}"}</code>:</span>
            <code className="rounded bg-[var(--bg)] px-2 py-1">{minted.orgId}</code>
            <Button size="sm" variant="outline" onClick={() => copy("org", minted.orgId)}>
              {copied === "org" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy id
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {orgs.length > 1 && (
            <Select
              value={orgId}
              onValueChange={(v) => {
                if (!v) return;
                setOrgId(String(v));
                onChange({ orgId: String(v) });
              }}
            >
              <SelectTrigger aria-label="Organization for the test token" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" onClick={() => void mint()} disabled={busy || !orgId}>
            Create a 1-hour read-only test token
          </Button>
          {error && <span role="alert" className="text-xs text-[var(--status-blocked-text,var(--status-blocked))]">{error}</span>}
        </div>
      )}
    </section>
  );
}
