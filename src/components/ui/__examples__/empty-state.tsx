import { Button } from "../button";
import { EmptyState } from "../empty-state";

export const emptyStateExamples = [
  {
    label: "No projects",
    node: (
      <EmptyState
        title="No projects yet"
        description="Projects bundle boards, sprints, and OKRs. Create one to start tracking your team's work."
        action={<Button>+ Create project</Button>}
      />
    ),
    code: `<EmptyState
  title="No projects yet"
  description="Projects bundle boards, sprints, and OKRs. Create one to start tracking your team's work."
  action={<Button>+ Create project</Button>}
/>`,
  },
  {
    label: "Title only",
    node: <EmptyState title="No results" />,
    code: '<EmptyState title="No results" />',
  },
];
