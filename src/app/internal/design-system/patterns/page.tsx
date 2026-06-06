import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";
import { CodeSnippet } from "@/components/ui/code-snippet";

export default function PatternsPage() {
  return (
    <PageShell title="Patterns" description="Higher-order compositions">
      <PageSection title="Standard dashboard page">
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Every dashboard page should be a{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">PageShell</code>{" "}
          wrapping one or more{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">PageSection</code>s.
          Use the{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">actions</code>{" "}
          slot for the primary call-to-action.
        </p>
        <CodeSnippet
          code={`<PageShell
  title="Active sprints"
  description="12 sprints across 4 projects"
  actions={<Button>New sprint</Button>}
>
  <PageSection title="Recent activity" action={{ label: "View all", href: "..." }}>
    {/* content */}
  </PageSection>
</PageShell>`}
        />
      </PageSection>

      <PageSection title="No-data state">
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Use{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">EmptyState</code>{" "}
          wherever you&apos;d otherwise render a list of zero items. Pair with the primary creation
          action via the{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">action</code>{" "}
          slot.
        </p>
        <CodeSnippet
          code={`{items.length === 0 ? (
  <EmptyState
    title="No notes yet"
    description="Create your first note to start capturing knowledge."
    action={<Button onClick={openCreateDialog}>+ New note</Button>}
  />
) : (
  <List items={items} />
)}`}
        />
      </PageSection>

      <PageSection title="Stat dashboard">
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          For overview pages, lead with a row of three{" "}
          <code className="rounded bg-[var(--primary-tint)] px-1 font-mono text-xs">StatCard</code>s.
          Compose Number, Bar, or Sparkline sub-components inside.
        </p>
        <CodeSnippet
          code={`<div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
  <StatCard label="Revenue" trend="+12%">
    <StatCard.Number>$48,200</StatCard.Number>
    <StatCard.Bar value={37800} max={48200} />
  </StatCard>
  <StatCard label="Active sprints" trend="+3">
    <StatCard.Number>12</StatCard.Number>
  </StatCard>
  <StatCard label="Sessions this week" trend="+8%">
    <StatCard.Number>1,847</StatCard.Number>
    <StatCard.Sparkline data={[120,145,132,178,196,210,240]} />
  </StatCard>
</div>`}
        />
      </PageSection>
    </PageShell>
  );
}
