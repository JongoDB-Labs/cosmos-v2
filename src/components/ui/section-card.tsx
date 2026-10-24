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
  level = 2,
  "data-tour": dataTour,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
  /**
   * The title's heading level. 2 by default: a card sits directly under the
   * page's h1 (PageShell). Pass 3 for a card inside a section that has its own h2.
   */
  level?: 2 | 3;
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
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className="rounded-lg border bg-card" data-tour={dataTour}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Icon className="size-4 text-muted-foreground" />
        <div>
          <Heading className="text-sm font-semibold">{title}</Heading>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
