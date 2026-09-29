import { cn } from "@/lib/utils";

export interface PageShellProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: "5xl" | "7xl" | "full";
  className?: string;
  /**
   * Marks this page's CONTENT as the target of a walkthrough step, as
   * [data-tour="<anchor>"].
   *
   * Set here rather than inside each page's own components because the useful
   * target is the same on every page -- the body below the title -- and putting
   * it on the shell means a page cannot acquire a stale one by being
   * refactored: the anchor lives with the route, not with whichever component
   * currently happens to render it.
   *
   * It wraps children rather than sitting on the outer container on purpose. A
   * highlight drawn around the whole page, title and all, is a box the reader
   * learns to ignore; one drawn around the thing the step is talking about is
   * the point of having one.
   */
  tourAnchor?: string;
}

const MAX_W = {
  "5xl": "max-w-5xl",
  "7xl": "max-w-7xl",
  full: "max-w-full",
} as const;

export function PageShell({
  title,
  description,
  actions,
  children,
  maxWidth = "7xl",
  className,
  tourAnchor,
}: PageShellProps) {
  return (
    <div className={cn("mx-auto px-4 py-5 md:p-8", MAX_W[maxWidth], className)}>
      <div className="mb-5 flex items-start justify-between gap-4 md:mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tourAnchor ? <div data-tour={tourAnchor}>{children}</div> : children}
    </div>
  );
}
