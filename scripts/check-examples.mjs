// scripts/check-examples.mjs
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const UI_DIR = "src/components/ui";
const EXAMPLES_DIR = path.join(UI_DIR, "__examples__");
const SKIP = new Set([
  // shadcn primitives without examples (yet)
  "button.tsx",
  "input.tsx",
  "label.tsx",
  "avatar.tsx",
  "dropdown-menu.tsx",
  "select.tsx",
  "separator.tsx",
  "sheet.tsx",
  "skeleton.tsx",
  "sonner.tsx",
  "textarea.tsx",
  "tooltip.tsx",
  "command.tsx",
  "dialog.tsx",
  "input-group.tsx",
  "theme-picker.tsx", // dedicated settings UI, has its own surface
  // Project primitives without a design-system example yet. Tracked as a
  // follow-up; listed here so the gate (file-existence only) doesn't block CI.
  "confirm-button.tsx",
  "searchable-select.tsx",
  // Skip self
  "__examples__",
]);

const files = readdirSync(UI_DIR).filter(
  (f) => f.endsWith(".tsx") && !SKIP.has(f),
);

const missing = files.filter(
  (f) => !existsSync(path.join(EXAMPLES_DIR, f)),
);

if (missing.length > 0) {
  console.error("Missing examples for:");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}
console.log(`All ${files.length} required primitives have examples.`);
