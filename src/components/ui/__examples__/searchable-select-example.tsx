"use client";
import { useState } from "react";
import { SearchableSelect } from "../searchable-select";

const MEMBERS = [
  { value: "ada", label: "Ada Lovelace" },
  { value: "alan", label: "Alan Turing" },
  { value: "grace", label: "Grace Hopper" },
  { value: "katherine", label: "Katherine Johnson" },
  { value: "linus", label: "Linus Torvalds" },
  { value: "margaret", label: "Margaret Hamilton" },
];

const PROJECTS = [
  { value: "atlas", label: "Atlas" },
  { value: "borealis", label: "Borealis" },
  { value: "cosmos", label: "Cosmos (archived)", disabled: true },
  { value: "delta", label: "Delta" },
];

export function SearchableSelectBasic() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="max-w-xs">
      <SearchableSelect
        value={value}
        onValueChange={setValue}
        options={MEMBERS}
        placeholder="Assign to…"
        searchPlaceholder="Search members…"
        aria-label="Assignee"
        className="w-full"
      />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Selected: {value ?? "(none)"}
      </p>
    </div>
  );
}

export function SearchableSelectPreset() {
  const [value, setValue] = useState<string | null>("grace");
  return (
    <div className="max-w-xs">
      <SearchableSelect
        value={value}
        onValueChange={setValue}
        options={MEMBERS}
        size="sm"
        placeholder="Assign to…"
        searchPlaceholder="Filter…"
        aria-label="Assignee (small)"
        className="w-full"
      />
    </div>
  );
}

export function SearchableSelectDisabledOption() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="max-w-xs">
      <SearchableSelect
        value={value}
        onValueChange={setValue}
        options={PROJECTS}
        placeholder="Pick a project…"
        searchPlaceholder="Filter projects…"
        emptyText="No projects found"
        aria-label="Project"
        className="w-full"
      />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Selected: {value ?? "(none)"}
      </p>
    </div>
  );
}
