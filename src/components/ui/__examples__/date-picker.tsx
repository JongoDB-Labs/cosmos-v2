import { DatePickerBasic, DatePickerPreset } from "./date-picker-example";

export const datePickerExamples = [
  {
    label: "Empty (placeholder)",
    node: <DatePickerBasic />,
    code: `const [value, setValue] = useState("");

<DatePicker value={value} onValueChange={setValue} aria-label="Due date" />`,
  },
  {
    label: "Pre-selected (clearable)",
    node: <DatePickerPreset />,
    code: `const [value, setValue] = useState("2026-06-15");

<DatePicker value={value} onValueChange={setValue} aria-label="Start date" />`,
  },
];
