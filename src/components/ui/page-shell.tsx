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
  /**
   * Lets wide `actions` drop below the title when both do not fit on one line,
   * and wrap among themselves. Without it the actions never shrink, so on a
   * phone a wide set squeezes the title to nothing. Opt-in: a page whose
   * actions are a button or two keeps the layout it has always had.
   */
  wrapActions?: boolean;
}

const MAX_W = {
  "5xl": "max-w-5xl",
  "7xl": "max-w-7xl",
  full: "max-w-full",
} as const;

/**
 * The box PageShell lays a page out in. Exported for loading skeletons: one
 * that sits in a different box makes the page jump when it arrives.
 */
export function pageShellBoxClassName(
  maxWidth: NonNullable<PageShellProps["maxWidth"]> = "7xl",
  className?: string,
): string {
  return cn("mx-auto px-4 py-5 md:p-8", MAX_W[maxWidth], className);
}

export function PageShell({
  title,
  description,
  actions,
  children,
  maxWidth = "7xl",
  className,
  tourAnchor,
  wrapActions = false,
}: PageShellProps) {
  return (
    <div className={pageShellBoxClassName(maxWidth, className)}>
      <div className={cn("mb-5 flex items-start justify-between gap-4 md:mb-8", wrapActions && "flex-wrap gap-y-3")}>
        {/* With wrapActions the title claims at least 16rem of the line; when
            the actions do not fit beside that, they move to the next line. */}
        <div className={cn("min-w-0", wrapActions && "flex-1 basis-64")}>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
          )}
        </div>
        {actions && (
          <div className={cn("flex items-center gap-2", wrapActions ? "min-w-0 flex-wrap" : "shrink-0")}>
            {actions}
          </div>
        )}
      </div>
      {tourAnchor ? <div data-tour={tourAnchor}>{children}</div> : children}
    </div>
  );
}
