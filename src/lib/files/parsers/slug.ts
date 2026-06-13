export function anchorAssigner() {
  const used = new Set<string>();
  return (text: string, ordinal: number): string => {
    let base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (!base) base = `block-${ordinal}`;
    let anchor = base, n = 2;
    while (used.has(anchor)) anchor = `${base}-${n++}`;
    used.add(anchor);
    return anchor;
  };
}
