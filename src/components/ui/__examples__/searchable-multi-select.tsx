import {
  SearchableMultiSelectBasic,
  SearchableMultiSelectPreset,
  SearchableMultiSelectDisabledOption,
} from "./searchable-multi-select-example";

export const searchableMultiSelectExamples = [
  {
    label: "Searchable multi-select",
    node: <SearchableMultiSelectBasic />,
    code: `const [value, setValue] = useState<string[]>([]);

<SearchableMultiSelect
  value={value}
  onValueChange={setValue}
  options={members}
  placeholder="Add assignees…"
  searchPlaceholder="Search members…"
  aria-label="Assignees"
/>`,
  },
  {
    label: "Pre-selected · order preserved · small",
    node: <SearchableMultiSelectPreset />,
    code: `const [value, setValue] = useState<string[]>(["ada", "grace", "margaret"]);

<SearchableMultiSelect
  value={value}
  onValueChange={setValue}
  options={members}
  maxLabels={2}
  size="sm"
  aria-label="Assignees"
/>`,
  },
  {
    label: "Disabled option · custom empty text",
    node: <SearchableMultiSelectDisabledOption />,
    code: `<SearchableMultiSelect
  value={value}
  onValueChange={setValue}
  options={[
    { value: "bug", label: "Bug" },
    { value: "archived", label: "Archived", disabled: true },
  ]}
  emptyText="No tags found"
  searchPlaceholder="Filter tags…"
/>`,
  },
];
