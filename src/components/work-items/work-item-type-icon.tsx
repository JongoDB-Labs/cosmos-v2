import { createElement } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bug,
  CalendarDays,
  CheckCircle,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Cog,
  Compass,
  DollarSign,
  Factory,
  FileCheck,
  FileEdit,
  FilePlus,
  FileQuestion,
  FileSearch,
  FileSignature,
  FileStack,
  FileText,
  FileWarning,
  Flag,
  Gauge,
  Gavel,
  GitBranch,
  GitPullRequest,
  Handshake,
  Layers,
  Layout,
  ListChecks,
  ListOrdered,
  Milestone,
  Package,
  Search,
  ShieldAlert,
  Store,
  Tag,
  Target,
  Ticket,
  TrendingUp,
  Truck,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";

// ── Icon map: work-item-type `icon` string (a lucide name, PascalCase) → the
// component. Work-item types store their glyph as a lucide icon *name* (see the
// sector seeds in prisma/seed/sectors/*), so every surface that shows a type
// must resolve that name to its SVG instead of printing the raw string. Covers
// the built-in sector types; custom types fall back to `Tag`.
const ICON_MAP: Record<string, LucideIcon> = {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bug,
  CalendarDays,
  CheckCircle,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Cog,
  Compass,
  DollarSign,
  Factory,
  FileCheck,
  FileEdit,
  FilePlus,
  FileQuestion,
  FileSearch,
  FileSignature,
  FileStack,
  FileText,
  FileWarning,
  Flag,
  Gauge,
  Gavel,
  GitBranch,
  GitPullRequest,
  Handshake,
  Layers,
  Layout,
  ListChecks,
  ListOrdered,
  Milestone,
  Package,
  Search,
  ShieldAlert,
  Store,
  Tag,
  Target,
  Ticket,
  TrendingUp,
  Truck,
  Upload,
  Wrench,
};

export function resolveWorkItemTypeIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Tag;
  return ICON_MAP[name] ?? Tag; // Tag as the neutral fallback for custom types.
}

/**
 * Render a work-item type's icon as an SVG glyph. Pass the type's `icon` string
 * (a lucide name); falls back to a neutral `Tag` for unknown/custom names. Use
 * this everywhere a type is shown so the stored name never leaks as raw text.
 */
export function WorkItemTypeIcon({
  icon,
  className = "h-3.5 w-3.5",
  color,
}: {
  icon: string | null | undefined;
  className?: string;
  color?: string | null;
}) {
  // createElement (not JSX) because the component comes from a runtime lookup —
  // the `react-hooks/static-components` lint rule flags a capitalized local used
  // as a JSX tag as "a component created during render".
  return createElement(resolveWorkItemTypeIcon(icon), {
    className,
    "aria-hidden": true,
    style: color ? { color } : undefined,
  });
}
