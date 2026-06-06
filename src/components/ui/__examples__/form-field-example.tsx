"use client";
import { useState } from "react";
import { FormField } from "../form-field";
import { Input } from "../input";

export function FormFieldBasic() {
  const [name, setName] = useState("");
  return (
    <div className="max-w-sm">
      <FormField label="Project name" required hint="Shown across the workspace.">
        {(control) => (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Apollo"
            {...control}
          />
        )}
      </FormField>
    </div>
  );
}

export function FormFieldWithError() {
  const [slug, setSlug] = useState("My Org!");
  const error = /[^a-z0-9-]/.test(slug)
    ? "Use lowercase letters, numbers, and dashes only."
    : null;
  return (
    <div className="max-w-sm">
      <FormField label="Slug" required error={error}>
        {(control) => (
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            {...control}
          />
        )}
      </FormField>
    </div>
  );
}
