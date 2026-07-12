import { Permission, type PermissionKey } from "./permissions";

// Group permission keys by their leading segment (e.g. ITEM_READ → "Item") for
// browsable checklists (RoleEditor) and read-only breakdowns (PermissionBreakdown).
// Moved from roles-manager.tsx verbatim — keep grouping/labeling behavior
// byte-identical; anything importing these must see the exact same output.
export const ALL_PERMISSIONS = Object.keys(Permission) as PermissionKey[];

export function groupOf(key: string): string {
  const seg = key.split("_")[0];
  return seg.charAt(0) + seg.slice(1).toLowerCase();
}

export function labelOf(key: string): string {
  return key
    .split("_")
    .slice(1)
    .join(" ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const PERMISSION_GROUPS = ALL_PERMISSIONS.reduce<Record<string, string[]>>(
  (acc, k) => {
    (acc[groupOf(k)] ??= []).push(k);
    return acc;
  },
  {},
);
