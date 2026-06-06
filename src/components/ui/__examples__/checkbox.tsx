import { CheckboxBasic, CheckboxIndeterminate } from "./checkbox-example";

export const checkboxExamples = [
  {
    label: "Controlled",
    node: <CheckboxBasic />,
    code: `const [checked, setChecked] = useState(true);

<Checkbox
  checked={checked}
  onChange={(e) => setChecked(e.target.checked)}
  aria-label="Enable notifications"
/>`,
  },
  {
    label: "Indeterminate + disabled",
    node: <CheckboxIndeterminate />,
    code: `<Checkbox indeterminate aria-label="Select all" />
<Checkbox checked aria-label="Item one" />
<Checkbox disabled aria-label="Item two" />`,
  },
];
