"use client";

import { useEffect, useState } from "react";
import { app, pages } from "@microsoft/teams-js";

/**
 * COSMOS-202 T1 d: the channel tab's configuration page. Pick a project; Teams
 * saves a tab that shows it (the view page, which signs in on its own).
 */
export function TabConfigure({ origin, org, projects }: { origin: string; org: string; projects: { key: string; label: string }[] }) {
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(false);
  const [outside, setOutside] = useState(false);

  useEffect(() => {
    // Outside Teams there is no host to talk to: say so rather than fail silently.
    app.initialize().then(() => setReady(true), () => setOutside(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    const p = projects.find((x) => x.key === key);
    pages.config.registerOnSaveHandler((evt) => {
      if (!p) return evt.notifyFailure("Pick a project.");
      void pages.config
        .setConfig({
          entityId: `cosmos-project-${org}-${p.key}`,
          contentUrl: `${origin}/teams/tab/view?org=${encodeURIComponent(org)}&project=${encodeURIComponent(p.key)}`,
          websiteUrl: `${origin}/${encodeURIComponent(org)}/issues`,
          suggestedDisplayName: p.label,
        })
        .then(() => evt.notifySuccess(), () => evt.notifyFailure("Teams didn't save the tab."));
    });
    void pages.config.setValidityState(!!p);
  }, [ready, key, org, origin, projects]);

  return (
    <main className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Show a Cosmos project in this channel</h1>
      {outside && <p role="status" className="text-sm">Open this in Microsoft Teams to add the tab.</p>}
      {projects.length ? (
        <label className="flex flex-col gap-1 text-sm">
          Project
          <select value={key} onChange={(e) => setKey(e.target.value)} className="rounded-md border bg-background px-2 py-1.5">
            <option value="">Pick a project…</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm">There are no Cosmos projects you can show here.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Everyone in the channel sees only what they can see in Cosmos, after signing in with their own account.
      </p>
    </main>
  );
}
