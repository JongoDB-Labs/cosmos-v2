import { FormFieldBasic, FormFieldWithError } from "./form-field-example";

export const formFieldExamples = [
  {
    label: "Required + hint",
    node: <FormFieldBasic />,
    code: `<FormField label="Project name" required hint="Shown across the workspace.">
  {(control) => (
    <Input value={name} onChange={(e) => setName(e.target.value)} {...control} />
  )}
</FormField>`,
  },
  {
    label: "Inline validation error",
    node: <FormFieldWithError />,
    code: `<FormField label="Slug" required error={error}>
  {(control) => (
    <Input value={slug} onChange={(e) => setSlug(e.target.value)} {...control} />
  )}
</FormField>`,
  },
];
