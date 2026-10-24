"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { app, authentication } from "@microsoft/teams-js";

/**
 * COSMOS-202 T1 d: signs a Teams tab in, silently. Teams hands us an SSO token
 * for this person (getAuthToken); the server verifies it and sets the tab's
 * own short session, then the page renders again with it. Nothing here reads
 * or stores the token beyond that one request.
 */

type State =
  | { kind: "working" }
  | { kind: "outside" }
  | { kind: "not_connected"; connectUrl: string }
  | { kind: "choose"; orgs: string[] }
  | { kind: "failed" };

const OUTSIDE_TEAMS_MS = 5_000;

export function TabSignIn({ org }: { org: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    let cancelled = false;
    const outside = setTimeout(() => !cancelled && setState({ kind: "outside" }), OUTSIDE_TEAMS_MS);
    (async () => {
      try {
        await app.initialize();
        clearTimeout(outside);
        const token = await authentication.getAuthToken();
        const res = await fetch("/api/teams/tab/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, org }),
        });
        if (cancelled) return;
        if (res.ok) return router.refresh();
        const body = (await res.json().catch(() => ({}))) as { error?: string; connectUrl?: string; orgs?: string[] };
        if (body.error === "not_connected" && body.connectUrl) setState({ kind: "not_connected", connectUrl: body.connectUrl });
        else if (body.error === "choose_org" && body.orgs) setState({ kind: "choose", orgs: body.orgs });
        else setState({ kind: "failed" });
      } catch {
        if (!cancelled) setState((s) => (s.kind === "outside" ? s : { kind: "failed" }));
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(outside);
    };
  }, [org, router]);

  return (
    <main className="p-6 text-sm">
      <h1 className="sr-only">Cosmos</h1>
      <div role="status">
        {state.kind === "working" && <p className="text-muted-foreground">Signing in to Cosmos…</p>}
        {state.kind === "outside" && <p>Open this tab in Microsoft Teams.</p>}
        {state.kind === "failed" && <p>Cosmos couldn&apos;t sign you in. Close and reopen the tab to try again.</p>}
        {state.kind === "not_connected" && (
          <p>
            Cosmos doesn&apos;t know who you are in Teams yet. In Cosmos, open Settings, Preferences and connect Outlook
            Calendar with your work account, then reopen this tab.{" "}
            <a href={state.connectUrl} target="_blank" rel="noreferrer" className="underline">
              Open Cosmos settings
            </a>
          </p>
        )}
        {state.kind === "choose" && (
          <div className="flex flex-col gap-2">
            <p>You use Cosmos in more than one organization. Which one?</p>
            <ul className="flex flex-col gap-1">
              {state.orgs.map((o) => (
                <li key={o}>
                  <a href={`?org=${encodeURIComponent(o)}`} className="underline">
                    {o}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
