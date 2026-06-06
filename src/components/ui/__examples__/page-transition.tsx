import { PageTransition } from "../page-transition";

export const pageTransitionExamples = [
  {
    label: "View-transition wrapper",
    node: (
      <PageTransition>
        <p className="text-sm text-[var(--text-muted)]">
          Tags this region with a View Transition name so route navigations
          cross-fade. Browsers without support degrade to a plain swap.
        </p>
      </PageTransition>
    ),
    code: `<PageTransition name="page">
  {children}
</PageTransition>`,
  },
];
