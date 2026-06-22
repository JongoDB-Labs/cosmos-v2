import type { ReactNode } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";
import { CodeSnippet } from "@/components/ui/code-snippet";
import { badgeExamples } from "@/components/ui/__examples__/badge";
import { statCardExamples } from "@/components/ui/__examples__/stat-card";
import { emptyStateExamples } from "@/components/ui/__examples__/empty-state";
import { pageShellExamples } from "@/components/ui/__examples__/page-shell";
import { pageSectionExamples } from "@/components/ui/__examples__/page-section";
import { dataTableExamples } from "@/components/ui/__examples__/data-table";
import { actionMenuExamples } from "@/components/ui/__examples__/action-menu";
import { checkboxExamples } from "@/components/ui/__examples__/checkbox";
import { codeSnippetExamples } from "@/components/ui/__examples__/code-snippet";
import { datePickerExamples } from "@/components/ui/__examples__/date-picker";
import { formFieldExamples } from "@/components/ui/__examples__/form-field";
import { loadErrorExamples } from "@/components/ui/__examples__/load-error";
import { motionConfigExamples } from "@/components/ui/__examples__/motion-config";
import { pageSkeletonExamples } from "@/components/ui/__examples__/page-skeleton";
import { pageTransitionExamples } from "@/components/ui/__examples__/page-transition";
import { sectionCardExamples } from "@/components/ui/__examples__/section-card";
import { staggeredGridExamples } from "@/components/ui/__examples__/staggered-grid";
import { toggleSwitchExamples } from "@/components/ui/__examples__/toggle-switch";
import { unsavedChangesGuardExamples } from "@/components/ui/__examples__/unsaved-changes-guard";
import { confirmButtonExamples } from "@/components/ui/__examples__/confirm-button";
import { searchableSelectExamples } from "@/components/ui/__examples__/searchable-select";

type Example = { label: string; node: ReactNode; code?: string };
type Section = { title: string; examples: Example[] };

const SECTIONS: Section[] = [
  { title: "Badge", examples: badgeExamples },
  { title: "StatCard", examples: statCardExamples },
  { title: "EmptyState", examples: emptyStateExamples },
  { title: "LoadError", examples: loadErrorExamples },
  { title: "PageShell", examples: pageShellExamples },
  { title: "PageSection", examples: pageSectionExamples },
  { title: "SectionCard", examples: sectionCardExamples },
  { title: "DataTable", examples: dataTableExamples },
  { title: "ActionMenu", examples: actionMenuExamples },
  { title: "ConfirmButton", examples: confirmButtonExamples },
  { title: "Checkbox", examples: checkboxExamples },
  { title: "ToggleSwitch", examples: toggleSwitchExamples },
  { title: "DatePicker", examples: datePickerExamples },
  { title: "SearchableSelect", examples: searchableSelectExamples },
  { title: "FormField", examples: formFieldExamples },
  { title: "CodeSnippet", examples: codeSnippetExamples },
  { title: "PageSkeleton", examples: pageSkeletonExamples },
  { title: "StaggeredGrid", examples: staggeredGridExamples },
  { title: "PageTransition", examples: pageTransitionExamples },
  { title: "MotionConfig", examples: motionConfigExamples },
  { title: "UnsavedChangesGuard", examples: unsavedChangesGuardExamples },
];

export default function ComponentsPage() {
  return (
    <PageShell title="Components" description="Every primitive in its variants">
      {SECTIONS.map((s) => (
        <PageSection key={s.title} title={s.title}>
          <div className="space-y-4">
            {s.examples.map((ex) => (
              <div
                key={ex.label}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
              >
                <p className="mb-4 text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  {ex.label}
                </p>
                {ex.node}
                {ex.code && <CodeSnippet code={ex.code} />}
              </div>
            ))}
          </div>
        </PageSection>
      ))}
    </PageShell>
  );
}
