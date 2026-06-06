import { ToggleSwitchBasic, ToggleSwitchStates } from "./toggle-switch-example";

export const toggleSwitchExamples = [
  {
    label: "Controlled",
    node: <ToggleSwitchBasic />,
    code: `const [on, setOn] = useState(true);

<ToggleSwitch
  checked={on}
  onCheckedChange={setOn}
  aria-label="Enable webhooks"
/>`,
  },
  {
    label: "On / Off / Disabled",
    node: <ToggleSwitchStates />,
    code: `<ToggleSwitch checked onCheckedChange={fn} aria-label="On" />
<ToggleSwitch checked={false} onCheckedChange={fn} aria-label="Off" />
<ToggleSwitch checked disabled onCheckedChange={fn} aria-label="Disabled" />`,
  },
];
