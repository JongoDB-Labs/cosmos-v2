import { PageSkeleton } from "../page-skeleton";

export const pageSkeletonExamples = [
  {
    label: "Rows only",
    node: <PageSkeleton rows={4} />,
    code: "<PageSkeleton rows={4} />",
  },
  {
    label: "With stat-card grid",
    node: <PageSkeleton rows={3} stats />,
    code: "<PageSkeleton rows={3} stats />",
  },
];
