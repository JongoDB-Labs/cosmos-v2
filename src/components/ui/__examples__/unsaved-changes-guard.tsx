import { UnsavedChangesGuardDemo } from "./unsaved-changes-guard-example";

export const unsavedChangesGuardExamples = [
  {
    label: "Form-leave guard (shown inert)",
    node: <UnsavedChangesGuardDemo />,
    code: `<UnsavedChangesGuard
  dirty={isDirty}
  onSave={async () => {
    const ok = await save();
    return ok; // true → proceed with the queued navigation
  }}
  onDiscard={() => reset()}
/>`,
  },
];
