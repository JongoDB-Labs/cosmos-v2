import type { TabView } from "@/lib/integrations/microsoft/teams-app/tab-data.server";

/** COSMOS-202 T1 d: a tab's items, by status. Read-only; each opens in Cosmos. */
export function TabViewList({ view }: { view: TabView }) {
  const count = view.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">{view.title}</h1>
      {count === 0 && <p className="text-sm text-muted-foreground">Nothing open here.</p>}
      {view.groups.map((g) => (
        <section key={g.status} aria-label={g.status} className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">
            {g.status} <span className="text-muted-foreground">({g.items.length})</span>
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {g.items.map((i) => (
              <li key={i.ref} className="flex items-center gap-3 px-3 py-2 text-sm">
                <a href={i.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs underline">
                  {i.ref}
                </a>
                {i.restricted ? (
                  <span className="text-muted-foreground">Restricted</span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{i.assignee ?? "Unassigned"}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {view.truncated && <p className="text-xs text-muted-foreground">Showing the most recently updated items. Open Cosmos for the rest.</p>}
    </main>
  );
}
