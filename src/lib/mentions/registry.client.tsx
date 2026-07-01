"use client";
/**
 * Client display metadata per entity type — icon + textual prefix — shared by
 * the @-mention picker, the rendered chips, and (optionally) the ⌘K palette.
 * Human labels live in `refs.ts` (`ENTITY_LABEL` / `ENTITY_LABEL_PLURAL`).
 */
import {
  User,
  CircleDot,
  FolderKanban,
  FileText,
  CalendarClock,
  LayoutGrid,
  Flag,
  Target,
  Goal,
  Gauge,
  File,
  AlertTriangle,
  Package,
  Ban,
  ArrowLeftRight,
  Receipt,
  Contact,
  Handshake,
  Box,
  type LucideIcon,
} from "lucide-react";
import type { EntityType } from "./refs";

export const ENTITY_ICON: Record<EntityType, LucideIcon> = {
  user: User,
  workItem: CircleDot,
  project: FolderKanban,
  note: FileText,
  meeting: CalendarClock,
  board: LayoutGrid,
  milestone: Flag,
  objective: Target,
  goal: Goal,
  kpi: Gauge,
  document: File,
  risk: AlertTriangle,
  deliverable: Package,
  blocker: Ban,
  changeRequest: ArrowLeftRight,
  clin: Receipt,
  crmContact: Contact,
  partner: Handshake,
  product: Box,
};

// ENTITY_PREFIX moved to refs.ts (pure data, importable in node/server too).
export { ENTITY_PREFIX } from "./refs";
