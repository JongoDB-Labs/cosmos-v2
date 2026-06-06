import { OrbitIllustration } from "@/components/brand/orbit-illustration";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  illustration?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  action,
  illustration,
}: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 w-24 opacity-90">
        {illustration ?? <OrbitIllustration />}
      </div>
      <h3 className="text-base font-semibold text-[var(--text)]">{title}</h3>
      {description && (
        <p className="mt-2 text-sm text-[var(--text-muted)]">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
