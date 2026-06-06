import { PageSection } from "../page-section";

export const pageSectionExamples = [
  {
    label: "Basic",
    node: (
      <PageSection title="Recent activity">
        <p className="text-sm text-[var(--text-muted)]">List content here.</p>
      </PageSection>
    ),
    code: `<PageSection title="Recent activity">
  {/* content */}
</PageSection>`,
  },
  {
    label: "With action",
    node: (
      <PageSection title="Active projects" action={{ label: "View all", href: "#" }}>
        <p className="text-sm text-[var(--text-muted)]">Grid content here.</p>
      </PageSection>
    ),
    code: `<PageSection
  title="Active projects"
  action={{ label: "View all", href: "/projects" }}
>
  {/* content */}
</PageSection>`,
  },
];
