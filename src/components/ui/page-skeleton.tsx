import { Skeleton } from "./skeleton";

interface PageSkeletonProps {
  /** Number of "row" skeletons to render in the body */
  rows?: number;
  /** Whether to render a stat-card grid above the rows */
  stats?: boolean;
}

export function PageSkeleton({ rows = 6, stats = false }: PageSkeletonProps) {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>

      {stats ? (
        <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
            >
              <Skeleton className="mb-3 h-3 w-24" />
              <Skeleton className="h-8 w-28" />
              <Skeleton className="mt-3 h-1.5 w-full" />
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
