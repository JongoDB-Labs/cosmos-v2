import { CATEGORY_META, type IntegrationCategory } from "./registry";

interface Filterable {
  slug: string; name: string; description: string; category: string;
}

export function filterProviders<T extends Filterable>(
  providers: T[],
  query: string,
  category: IntegrationCategory | "all",
): T[] {
  const q = query.trim().toLowerCase();
  return providers.filter((p) => {
    if (category !== "all" && p.category !== category) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });
}

export function groupByCategory<T extends Filterable>(
  providers: T[],
): { category: IntegrationCategory; label: string; providers: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const p of providers) {
    if (!buckets.has(p.category)) buckets.set(p.category, []);
    buckets.get(p.category)!.push(p);
  }
  return Array.from(buckets.entries())
    .map(([category, items]) => ({
      category: category as IntegrationCategory,
      label: CATEGORY_META[category as IntegrationCategory]?.label ?? category,
      providers: items,
    }))
    .sort(
      (a, b) =>
        (CATEGORY_META[a.category]?.order ?? 99) -
        (CATEGORY_META[b.category]?.order ?? 99),
    );
}
