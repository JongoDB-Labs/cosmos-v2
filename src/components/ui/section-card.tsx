/**
 * A card with an icon + title + description header, used to group related
 * controls in settings panels. Plain-CSS, no client interactivity, so it
 * can be rendered from server components too.
 */
export function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Icon className="size-4 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
