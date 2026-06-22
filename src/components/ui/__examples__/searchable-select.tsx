import {
  SearchableSelectBasic,
  SearchableSelectPreset,
  SearchableSelectDisabledOption,
} from "./searchable-select-example";

export const searchableSelectExamples = [
  {
    label: "Searchable single-select",
    node: <SearchableSelectBasic />,
    code: `const [value, setValue] = useState<string | null>(null);

<SearchableSelect
  value={value}
  onValueChange={setValue}
  options={members}
  placeholder="Assign to…"
  searchPlaceholder="Search members…"
  aria-label="Assignee"
/>`,
  },
  {
    label: "Pre-selected · small",
    node: <SearchableSelectPreset />,
    code: `const [value, setValue] = useState<string | null>("grace");

<SearchableSelect
  value={value}
  onValueChange={setValue}
  options={members}
  size="sm"
  aria-label="Assignee"
/>`,
  },
  {
    label: "Disabled option · custom empty text",
    node: <SearchableSelectDisabledOption />,
    code: `<SearchableSelect
  value={value}
  onValueChange={setValue}
  options={[
    { value: "atlas", label: "Atlas" },
    { value: "cosmos", label: "Cosmos (archived)", disabled: true },
  ]}
  emptyText="No projects found"
  searchPlaceholder="Filter projects…"
/>`,
  },
];
