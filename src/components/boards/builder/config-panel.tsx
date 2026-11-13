"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Settings2 } from "lucide-react";
import {
  WIDGET_METRICS,
  WIDGET_GROUPS,
  WIDGET_RATIOS,
  widgetDays,
  widgetMaxItems,
} from "@/lib/boards/widget-data";
import { widgetDefinition } from "@/lib/boards/widget-definitions";
import type { BuilderWidget } from "@/types/models";

/** The widgets that break the board's items down by one grouping. */
const GROUPED_TYPES = new Set(["bar-chart", "pie-chart", "grouped-list"]);

/**
 * The widgets with a row cap, and the cap each one uses when none is set — the
 * same fallback the widget itself passes to `widgetMaxItems`, so the number
 * shown here is the number the tile is actually using.
 */
const MAX_ITEMS_DEFAULT: Record<string, number> = {
  list: 10,
  table: 25,
  "grouped-list": 25,
  checklist: 25,
  "activity-feed": 10,
  "deadline-list": 10,
  gantt: 12,
  "aec.rfi-tracker": 25,
  "aec.submittal-log": 25,
  "ops.incident-summary": 25,
};

interface ConfigPanelProps {
  widget: BuilderWidget | null;
  onUpdateConfig: (config: Record<string, unknown>) => void;
  onDelete: () => void;
}

export function ConfigPanel({ widget, onUpdateConfig, onDelete }: ConfigPanelProps) {
  if (!widget) {
    return (
      <div className="flex flex-col w-72 border-l bg-muted/30">
        <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
          <Settings2 className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">No widget selected</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click a widget on the canvas to configure it
            </p>
          </div>
        </div>
      </div>
    );
  }

  const config = widget.config;

  return (
    <div className="flex flex-col w-72 border-l bg-muted/30 overflow-y-auto">
      <div className="flex items-center justify-between p-3 border-b">
        <div>
          <h3 className="text-sm font-semibold">Configure</h3>
          <p className="text-xs text-muted-foreground">
            {widgetDefinition(widget.type)?.name ?? widget.type}
          </p>
        </div>
        <Button
          variant="destructive"
          size="icon-sm"
          onClick={onDelete}
          aria-label="Remove widget"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="widget-title">Title</Label>
          <Input
            id="widget-title"
            value={(config.title as string) ?? ""}
            onChange={(e) => onUpdateConfig({ title: e.target.value })}
            placeholder="Widget title"
          />
        </div>

        {/* Text content — for text block */}
        {widget.type === "text-block" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-content">Content</Label>
            <textarea
              id="widget-content"
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={(config.content as string) ?? ""}
              onChange={(e) => onUpdateConfig({ content: e.target.value })}
              placeholder="Enter text content..."
            />
          </div>
        )}

        {/* Link list — for link list */}
        {widget.type === "link-list" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-links">Links (one per line, format: Label|URL)</Label>
            <textarea
              id="widget-links"
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={(config.links as string) ?? ""}
              onChange={(e) => onUpdateConfig({ links: e.target.value })}
              placeholder={"Docs|https://...\nAPI|https://..."}
            />
          </div>
        )}

        {/* Which number — for the widgets a DASHBOARD board draws from a single
            metric. Without this the builder could add a counter but never say
            WHAT it counts, so every one of them would read the total: a control
            whose only value was its default. */}
        {(widget.type === "counter" || widget.type === "kpi-card") && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label>Metric</Label>
              <Select
                value={(config.metric as string) ?? "total"}
                onValueChange={(val) => onUpdateConfig({ metric: val })}
              >
                {/* `aria-label`, because `<Label>` renders a <label> with no
                    `for` and base-ui's trigger is a role="combobox" BUTTON, not
                    an input — so the visible caption gives it no accessible
                    name. That is `select-name` (critical), it is already in the
                    e2e gate's `wcag2a` set, and the gate would never see it:
                    its route list does not include the builder. The same shape
                    shipped on Table's "Group by" for exactly that reason.
                    `filter-bar.tsx` names all eleven of its triggers this way. */}
                <SelectTrigger className="w-full" aria-label="Metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WIDGET_METRICS.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="widget-label-text">Label</Label>
              <Input
                id="widget-label-text"
                value={(config.label as string) ?? ""}
                onChange={(e) => onUpdateConfig({ label: e.target.value })}
                placeholder="Defaults to the metric's name"
              />
            </div>
          </>
        )}

        {/* Target — a KPI without one is just a counter. Left blank on purpose
            when there is no target: the widget then says so rather than
            comparing against an invented zero. */}
        {widget.type === "kpi-card" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-target">Target</Label>
            <Input
              id="widget-target"
              type="number"
              value={(config.target as number | string) ?? ""}
              onChange={(e) =>
                onUpdateConfig({
                  target: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              placeholder="No target"
            />
          </div>
        )}

        {/* What the bars, slices or groups are. Same reasoning as Metric
            above. */}
        {GROUPED_TYPES.has(widget.type) && (
          <div className="flex flex-col gap-1.5">
            <Label>Group by</Label>
            <Select
              value={(config.groupBy as string) ?? "status"}
              onValueChange={(val) => onUpdateConfig({ groupBy: val })}
            >
              <SelectTrigger className="w-full" aria-label="Group by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WIDGET_GROUPS.map((g) => (
                  <SelectItem key={g.key} value={g.key}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Which share a gauge shows. */}
        {widget.type === "gauge" && (
          <div className="flex flex-col gap-1.5">
            <Label>Share of items</Label>
            <Select
              value={(config.metric as string) ?? "completed"}
              onValueChange={(val) => onUpdateConfig({ metric: val })}
            >
              <SelectTrigger className="w-full" aria-label="Share of items">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WIDGET_RATIOS.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* How far back the area chart reaches. */}
        {widget.type === "area-chart" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-days">Days shown</Label>
            <Input
              id="widget-days"
              type="number"
              min={7}
              max={365}
              value={widgetDays(config, 30)}
              onChange={(e) =>
                onUpdateConfig({ days: parseInt(e.target.value, 10) || 30 })
              }
            />
          </div>
        )}

        {/* The button's own words. */}
        {widget.type === "quick-action" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-button-label">Button label</Label>
            <Input
              id="widget-button-label"
              value={(config.label as string) ?? ""}
              onChange={(e) => onUpdateConfig({ label: e.target.value })}
              placeholder="New work item"
            />
          </div>
        )}

        {/* Row cap — for the widgets that list items. */}
        {widget.type in MAX_ITEMS_DEFAULT && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-max-items">Max items</Label>
            <Input
              id="widget-max-items"
              type="number"
              min={1}
              max={50}
              value={widgetMaxItems(config, MAX_ITEMS_DEFAULT[widget.type])}
              onChange={(e) =>
                onUpdateConfig({
                  maxItems:
                    parseInt(e.target.value, 10) || MAX_ITEMS_DEFAULT[widget.type],
                })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
