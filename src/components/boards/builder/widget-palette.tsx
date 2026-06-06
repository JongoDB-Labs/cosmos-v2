"use client";

import { cn } from "@/lib/utils";
import {
  Activity,
  AlarmClock,
  AlignLeft,
  AreaChart,
  BarChart3,
  CalendarDays,
  GanttChartSquare,
  Gauge,
  Globe,
  Hash,
  LineChart,
  Link,
  List,
  ListChecks,
  ListTree,
  PieChart,
  SlidersHorizontal,
  Table2,
  TrendingDown,
  TrendingUp,
  Type,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  WIDGET_DEFINITIONS,
  getWidgetDefinitions,
  type WidgetDefinition,
} from "@/lib/boards/widget-definitions";

// ── Icon map: lucide name → component ─────────────────────────────────────────
const ICON_MAP: Record<string, LucideIcon> = {
  Activity,
  AlarmClock,
  AlignLeft,
  AreaChart,
  BarChart3,
  CalendarDays,
  GanttChartSquare,
  Gauge,
  Globe,
  Hash,
  LineChart,
  Link,
  List,
  ListChecks,
  ListTree,
  PieChart,
  SlidersHorizontal,
  Table2,
  TrendingDown,
  TrendingUp,
  Type,
  Zap,
};

function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Hash; // Hash as fallback
}

// ── Re-export PaletteWidget so board-builder.tsx import keeps working ─────────
export interface PaletteWidget {
  type: string;
  name: string;
  icon: LucideIcon;
  category: string;
  defaultW: number;
  defaultH: number;
}

/** Convert a WidgetDefinition to the PaletteWidget shape expected by the canvas. */
function toPaletteWidget(def: WidgetDefinition): PaletteWidget {
  return {
    type: def.type,
    name: def.name,
    icon: resolveIcon(def.icon),
    category: def.category,
    defaultW: def.defaultW,
    defaultH: def.defaultH,
  };
}

// Keep the named export so any legacy import of `paletteWidgets` still works.
export const paletteWidgets: PaletteWidget[] = WIDGET_DEFINITIONS.filter(
  (w) => !w.sector
).map(toPaletteWidget);

// ── Category metadata ──────────────────────────────────────────────────────────
const GENERIC_CATEGORY_LABELS: Record<string, string> = {
  data: "Data",
  time: "Time",
  content: "Content",
  interactive: "Interactive",
};

const GENERIC_CATEGORY_ORDER = ["data", "time", "content", "interactive"] as const;

const SECTOR_LABEL_MAP: Record<string, string> = {
  software: "Software",
  aec: "AEC",
  ops: "Operations",
  manufacturing: "Manufacturing",
  education: "Education",
  event: "Events",
  consulting: "Consulting",
};

// ── Props ──────────────────────────────────────────────────────────────────────
interface WidgetPaletteProps {
  onAddWidget: (widget: PaletteWidget) => void;
  /** Pass a sector slug to include that sector's skins. Omit for generics only. */
  sector?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────
export function WidgetPalette({ onAddWidget, sector }: WidgetPaletteProps) {
  const allDefs = getWidgetDefinitions(sector);
  const generics = allDefs.filter((w) => !w.sector);
  const skins = allDefs.filter((w) => !!w.sector);

  function renderButton(def: WidgetDefinition) {
    const palette = toPaletteWidget(def);
    const Icon = palette.icon;
    return (
      <button
        key={def.type}
        onClick={() => onAddWidget(palette)}
        title={def.description}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left w-full",
          "hover:bg-muted transition-colors"
        )}
      >
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="truncate">{def.name}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col w-60 border-r bg-muted/30 overflow-y-auto">
      <div className="p-3 border-b">
        <h3 className="text-sm font-semibold">Widgets</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Click to add to canvas
        </p>
      </div>

      {/* Generic categories */}
      {GENERIC_CATEGORY_ORDER.map((cat) => {
        const items = generics.filter((w) => w.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="p-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {GENERIC_CATEGORY_LABELS[cat]}
            </div>
            <div className="flex flex-col gap-0.5 mt-1">
              {items.map(renderButton)}
            </div>
          </div>
        );
      })}

      {/* Sector skins — only shown when a sector is active */}
      {skins.length > 0 && (
        <div className="p-2 border-t">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {sector ? `${SECTOR_LABEL_MAP[sector] ?? sector} Skins` : "Sector Skins"}
          </div>
          <div className="flex flex-col gap-0.5 mt-1">
            {skins.map(renderButton)}
          </div>
        </div>
      )}
    </div>
  );
}
