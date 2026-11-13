import Link from "next/link";
import { cn } from "@/lib/utils";

export type ProgramView = "overview" | "calendar";

/** `?view=` to a view. Anything unknown is the overview, so an old or mistyped
 *  link still opens the page. */
export function parseProgramView(raw: string | undefined): ProgramView {
  return raw === "calendar" ? "calendar" : "overview";
}

/** The page's address for one view and scope. The one place it is built, so
 *  the switch and the project picker cannot disagree about it. */
export function programManagementHref(orgSlug: string, view: ProgramView, projectKey: string | null): string {
  const q = new URLSearchParams();
  if (projectKey) q.set("project", projectKey);
  if (view !== "overview") q.set("view", view);
  const s = q.toString();
  return `/${encodeURIComponent(orgSlug)}/program-management${s ? `?${s}` : ""}`;
}

/**
 * Overview or Calendar. Links rather than buttons: each view is its own
 * address, so it can be bookmarked, opened in a new tab and sent to someone,
 * and the browser's Back goes where people expect.
 *
 * It keeps the project that is picked, so switching views does not throw away
 * the scope the reader just chose.
 */
export function ProgramViews({
  orgSlug,
  view,
  projectKey,
}: {
  orgSlug: string;
  view: ProgramView;
  projectKey: string | null;
}) {
  const items: { key: ProgramView; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "calendar", label: "Calendar" },
  ];
  return (
    <nav aria-label="Program Management views" className="flex items-center gap-0.5 rounded-md border p-0.5">
      {items.map((i) => (
        <Link
          key={i.key}
          href={programManagementHref(orgSlug, i.key, projectKey)}
          aria-current={i.key === view ? "page" : undefined}
          className={cn(
            "rounded px-2.5 py-1 text-sm font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            i.key === view
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
