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
  "data-tour": dataTour,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
  /**
   * Marks this card as the target of a guided walkthrough step.
   *
   * Declared explicitly rather than spreading unknown props: this component
   * destructures what it takes, so an attribute passed in from outside is
   * dropped silently, and a walkthrough step that highlights nothing gives no
   * clue why.
   */
  "data-tour"?: string;
}) {
  return (
    <div className="rounded-lg border bg-card" data-tour={dataTour}>
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
