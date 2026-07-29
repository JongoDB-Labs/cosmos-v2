"use client";

import { createElement } from "react";

import {
  AlertOctagon, AlertTriangle, ArrowRight, BookOpen, Bug, CalendarDays,
  CheckCircle, CheckSquare, ClipboardCheck, ClipboardList, Clock, Cog, Compass,
  DollarSign, Factory, FileCheck, FileEdit, FilePlus, FileQuestion, FileSearch,
  FileSignature, FileStack, FileText, FileWarning, Flag, Gauge, Gavel,
  GitBranch, GitPullRequest, Handshake, Hash, Layers, Layout, ListChecks,
  ListOrdered, Milestone, Package, Search, ShieldAlert, Store, Tag, Target,
  Ticket, TrendingUp, Truck, Upload, Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * `WorkItemType.icon` holds a lucide component NAME ("CheckSquare", "Layers",
 * "Flag") — the seeds store it as a string because the database cannot hold a
 * component. Rendering that field directly prints the name, which is why the
 * Issues table read "CheckSquare Task" and "Layers Feature" instead of showing
 * an icon beside the type.
 *
 * Covers every name the seeds use. Unknown names — a custom type an org made
 * with an icon we do not bundle — fall back to a neutral glyph rather than
 * leaking the raw string back into the UI.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  AlertOctagon, AlertTriangle, ArrowRight, BookOpen, Bug, CalendarDays,
  CheckCircle, CheckSquare, ClipboardCheck, ClipboardList, Clock, Cog, Compass,
  DollarSign, Factory, FileCheck, FileEdit, FilePlus, FileQuestion, FileSearch,
  FileSignature, FileStack, FileText, FileWarning, Flag, Gauge, Gavel,
  GitBranch, GitPullRequest, Handshake, Layers, Layout, ListChecks,
  ListOrdered, Milestone, Package, Search, ShieldAlert, Store, Tag, Target,
  Ticket, TrendingUp, Truck, Upload, Wrench,
};

export function resolveWorkItemTypeIcon(name: string | null | undefined): LucideIcon {
  return (name && ICON_MAP[name]) || Hash;
}

/**
 * The type's icon, tinted with the type's colour. Decorative: the type NAME is
 * always rendered next to it, so this carries no information of its own.
 */
export function WorkItemTypeIcon({
  icon,
  color,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  icon?: string | null;
  color?: string | null;
  className?: string;
}) {
  // createElement rather than `const Icon = …; <Icon />`. The lint rule
  // (react-hooks/static-components) rejects binding a component to a variable
  // during render — it cannot tell "picked from a frozen map" apart from
  // "defined inline", and the latter would remount and lose state every render.
  // Selecting from a module-level map has neither problem, and going through
  // createElement says so without suppressing the rule.
  return createElement(resolveWorkItemTypeIcon(icon), {
    className,
    style: color ? { color } : undefined,
    "aria-hidden": true,
  });
}
