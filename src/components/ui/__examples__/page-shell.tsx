import { Button } from "../button";
import { PageShell } from "../page-shell";

export const pageShellExamples = [
  {
    label: "Title only",
    node: (
      <PageShell title="Active sprints">
        <div className="rounded border border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
          Content goes here
        </div>
      </PageShell>
    ),
    code: `<PageShell title="Active sprints">
  {/* content */}
</PageShell>`,
  },
  {
    label: "Title + description + actions",
    node: (
      <PageShell
        title="Active sprints"
        description="12 sprints across 4 projects"
        actions={<Button>New sprint</Button>}
      >
        <div className="rounded border border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
          Content goes here
        </div>
      </PageShell>
    ),
    code: `<PageShell
  title="Active sprints"
  description="12 sprints across 4 projects"
  actions={<Button>New sprint</Button>}
>
  {/* content */}
</PageShell>`,
  },
];
