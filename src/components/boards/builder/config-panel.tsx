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
import { WIDGET_METRICS, WIDGET_GROUPS } from "@/lib/boards/widget-data";
import type { BuilderWidget } from "@/types/models";

const presetColors = [
  { label: "Blue", value: "#3b82f6" },
  { label: "Green", value: "#22c55e" },
  { label: "Yellow", value: "#eab308" },
  { label: "Red", value: "#ef4444" },
  { label: "Purple", value: "#a855f7" },
  { label: "Pink", value: "#ec4899" },
  { label: "Orange", value: "#f97316" },
  { label: "Gray", value: "#6b7280" },
];

const dataSources = [
  { label: "Work Items", value: "work-items" },
  { label: "Sprints", value: "sprints" },
  { label: "Objectives", value: "objectives" },
  { label: "Activity", value: "activity" },
  { label: "Members", value: "members" },
];

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
          <p className="text-xs text-muted-foreground capitalize">
            {widget.type.replace(/-/g, " ")}
          </p>
        </div>
        <Button variant="destructive" size="icon-sm" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
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

        {/* Data source — for data widgets */}
        {(widget.type === "card-list" ||
          widget.type === "metric-counter" ||
          widget.type === "bar-chart" ||
          widget.type === "pie-chart" ||
          widget.type === "activity-feed" ||
          widget.type === "burndown-chart") && (
          <div className="flex flex-col gap-1.5">
            <Label>Data Source</Label>
            <Select
              value={(config.dataSource as string) ?? "work-items"}
              onValueChange={(val) => onUpdateConfig({ dataSource: val })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dataSources.map((src) => (
                  <SelectItem key={src.value} value={src.value}>
                    {src.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Color */}
        <div className="flex flex-col gap-1.5">
          <Label>Color</Label>
          <Select
            value={(config.color as string) ?? "#3b82f6"}
            onValueChange={(val) => onUpdateConfig({ color: val })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {presetColors.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 rounded-full border"
                      style={{ backgroundColor: c.value }}
                    />
                    {c.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

        {/* Metric label — for metric counter */}
        {widget.type === "metric-counter" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-label">Label</Label>
            <Input
              id="widget-label"
              value={(config.label as string) ?? ""}
              onChange={(e) => onUpdateConfig({ label: e.target.value })}
              placeholder="e.g. Open Issues"
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

        {/* What the bars are. Same reasoning as Metric above. */}
        {widget.type === "bar-chart" && (
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

        {/* Max items — for lists/feeds */}
        {(widget.type === "card-list" ||
          widget.type === "activity-feed" ||
          widget.type === "list" ||
          widget.type === "table") && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-max-items">Max Items</Label>
            <Input
              id="widget-max-items"
              type="number"
              min={1}
              max={50}
              value={(config.maxItems as number) ?? 10}
              onChange={(e) =>
                onUpdateConfig({ maxItems: parseInt(e.target.value, 10) || 10 })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
