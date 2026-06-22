import {
  ConfirmButtonBasic,
  ConfirmButtonVariants,
  ConfirmButtonPending,
} from "./confirm-button-example";

export const confirmButtonExamples = [
  {
    label: "Two-step confirm (destructive)",
    node: <ConfirmButtonBasic />,
    code: `<ConfirmButton onConfirm={deleteProject}>
  Delete project
</ConfirmButton>`,
  },
  {
    label: "Custom label · variant · size · disabled",
    node: <ConfirmButtonVariants />,
    code: `<ConfirmButton
  variant="outline"
  size="sm"
  confirmLabel="Yes, disconnect"
  onConfirm={disconnect}
>
  Disconnect
</ConfirmButton>

<ConfirmButton disabled onConfirm={noop}>
  Delete (disabled)
</ConfirmButton>`,
  },
  {
    label: "Pending (in-flight)",
    node: <ConfirmButtonPending />,
    code: `// pending shows a spinner and disables confirm/cancel
<ConfirmButton
  confirmLabel="Revoke key"
  pending={mutation.isPending}
  onConfirm={() => mutation.mutate()}
>
  Revoke API key
</ConfirmButton>`,
  },
];
