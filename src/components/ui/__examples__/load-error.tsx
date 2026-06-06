import { LoadError } from "../load-error";
import { LoadErrorWithRetry, LoadErrorCustom } from "./load-error-example";

export const loadErrorExamples = [
  {
    label: "With retry",
    node: <LoadErrorWithRetry />,
    code: `<LoadError onRetry={() => refetch()} />`,
  },
  {
    label: "Custom copy",
    node: <LoadErrorCustom />,
    code: `<LoadError
  title="Couldn't load themes"
  description="The theme service didn't respond. Try again in a moment."
  onRetry={() => refetch()}
/>`,
  },
  {
    // Static, no callback — safe to render inline from a server component.
    label: "No retry action",
    node: <LoadError title="Couldn't load this" />,
    code: `<LoadError title="Couldn't load this" />`,
  },
];
