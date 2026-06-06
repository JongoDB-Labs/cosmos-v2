import { StaggeredGrid } from "../staggered-grid";

export const staggeredGridExamples = [
  {
    label: "Staggered fade-in cards",
    node: (
      <StaggeredGrid className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((name) => (
          <div
            key={name}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-4 text-sm"
          >
            {name}
          </div>
        ))}
      </StaggeredGrid>
    ),
    code: `<StaggeredGrid className="grid grid-cols-3 gap-3">
  {items.map((item) => (
    <Card key={item.id}>{item.name}</Card>
  ))}
</StaggeredGrid>`,
  },
];
