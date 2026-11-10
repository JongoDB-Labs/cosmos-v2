"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export interface PickerProject {
  /** Project key (PRJ-style), which is what goes in the URL. */
  key: string;
  name: string;
}

/**
 * Scope selector for the Program Management page: the whole portfolio, or one
 * project.
 *
 * The selected value arrives as a PROP rather than being read from
 * `useSearchParams` here. Cache Components requires any component reading
 * search params to sit inside its own <Suspense> boundary, and omitting that
 * boundary is silent in dev, in CI and in the build -- it only shows up as a
 * prerender error later. Taking the value from the server component that
 * already awaited `searchParams` sidesteps the whole class of mistake, and
 * this control has no other reason to be dynamic.
 */
export function ProjectPicker({
  orgSlug,
  projects,
  selectedKey,
}: {
  orgSlug: string;
  projects: PickerProject[];
  selectedKey: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-[var(--text-muted)]">Project</span>
      <select
        value={selectedKey ?? ""}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          const href = next
            ? `/${orgSlug}/program-management?project=${encodeURIComponent(next)}`
            : `/${orgSlug}/program-management`;
          startTransition(() => router.push(href));
        }}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
