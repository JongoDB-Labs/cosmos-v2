function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [bright, dim] = la > lb ? [la, lb] : [lb, la];
  return (bright + 0.05) / (dim + 0.05);
}

export function passesAA(
  fg: string,
  bg: string,
  size: "normal" | "large" = "normal",
): boolean {
  const ratio = contrastRatio(fg, bg);
  return size === "large" ? ratio >= 3 : ratio >= 4.5;
}
