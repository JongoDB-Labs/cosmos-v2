"use client";
import { useState } from "react";
import { SearchableMultiSelect } from "../searchable-multi-select";

const MEMBERS = [
  { value: "ada", label: "Ada Lovelace" },
  { value: "alan", label: "Alan Turing" },
  { value: "grace", label: "Grace Hopper" },
  { value: "katherine", label: "Katherine Johnson" },
  { value: "linus", label: "Linus Torvalds" },
  { value: "margaret", label: "Margaret Hamilton" },
];

const TAGS = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "docs", label: "Docs" },
  { value: "archived", label: "Archived", disabled: true },
];

export function SearchableMultiSelectBasic() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <div className="max-w-xs">
      <SearchableMultiSelect
        value={value}
        onValueChange={setValue}
        options={MEMBERS}
        placeholder="Add assignees…"
        searchPlaceholder="Search members…"
        aria-label="Assignees"
        className="w-full"
      />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Selected: {value.length ? value.join(", ") : "(none)"}
      </p>
    </div>
  );
}

export function SearchableMultiSelectPreset() {
  const [value, setValue] = useState<string[]>(["ada", "grace", "margaret"]);
  return (
    <div className="max-w-xs">
      <SearchableMultiSelect
        value={value}
        onValueChange={setValue}
        options={MEMBERS}
        maxLabels={2}
        size="sm"
        aria-label="Assignees (small)"
        className="w-full"
      />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Order preserved: {value.join(" → ")}
      </p>
    </div>
  );
}

export function SearchableMultiSelectDisabledOption() {
  const [value, setValue] = useState<string[]>(["bug"]);
  return (
    <div className="max-w-xs">
      <SearchableMultiSelect
        value={value}
        onValueChange={setValue}
        options={TAGS}
        placeholder="Pick tags…"
        searchPlaceholder="Filter tags…"
        emptyText="No tags found"
        aria-label="Tags"
        className="w-full"
      />
    </div>
  );
}
