import { ActionMenuBasic, ActionMenuLabeledGroup } from "./action-menu-example";

export const actionMenuExamples = [
  {
    label: "Two groups + destructive item",
    node: <ActionMenuBasic />,
    code: `<ActionMenu
  groups={[
    { items: [
      { label: "Edit", icon: Pencil, onClick: edit },
      { label: "Duplicate", icon: Copy, onClick: dup },
    ] },
    { items: [
      { label: "Archive", icon: Archive, onClick: archive },
      { label: "Delete", icon: Trash2, variant: "destructive", onClick: del },
    ] },
  ]}
>
  {rowContent}
</ActionMenu>`,
  },
  {
    label: "Labeled group + disabled item",
    node: <ActionMenuLabeledGroup />,
    code: `<ActionMenu
  groups={[
    { label: "Manage", items: [
      { label: "Rename", icon: Pencil, onClick: rename },
      { label: "Duplicate", icon: Copy, onClick: dup, disabled: true },
    ] },
  ]}
>
  {rowContent}
</ActionMenu>`,
  },
];
