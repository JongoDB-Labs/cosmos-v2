"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { celebrate } from "@/lib/confetti";
import { jsonFetch } from "@/lib/query/json-fetcher";

/**
 * Canonical form pattern for the project: react-hook-form + zodResolver.
 * Per-field validation runs on blur, full-form validation runs on submit.
 * Surfacing field errors inline keeps the keyboard-focus contract intact
 * (no popover/toast for a missing required field).
 */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

const onboardingSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters."),
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9-]{2,50}$/,
      "Slug must be 2–50 chars, lowercase letters / numbers / dashes only.",
    ),
});

type OnboardingValues = z.infer<typeof onboardingSchema>;

export function OnboardingForm() {
  const router = useRouter();

  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, isSubmitting },
    setError: setFieldError,
  } = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    mode: "onBlur",
    defaultValues: { name: "", slug: "" },
  });

  // useWatch (vs watch()) returns memoizable values — keeps React Compiler
  // happy and avoids the "incompatible library" warning.
  const name = useWatch({ control, name: "name" });
  const slug = useWatch({ control, name: "slug" });

  // Live-slug the name field whenever the user hasn't manually edited slug.
  useEffect(() => {
    if (!slug || slug === slugify(name).slice(0, slug.length + 1)) {
      setValue("slug", slugify(name), { shouldValidate: false });
    }
    // intentionally tracking name only — slug edits opt out via the
    // explicit input handler below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const createOrg = useMutation({
    mutationFn: (payload: OnboardingValues) =>
      jsonFetch<{ slug: string }>("/api/v1/orgs", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (org) => {
      celebrate();
      router.push(`/${org.slug}`);
      router.refresh();
    },
    onError: (e: Error) =>
      setFieldError("root", { type: "server", message: e.message }),
  });

  const submitting = isSubmitting || createOrg.isPending;

  return (
    <form
      onSubmit={handleSubmit((values) => createOrg.mutate(values))}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label
          htmlFor="org-name"
          className="text-xs uppercase tracking-wide text-[var(--text-muted)]"
        >
          Organization name
        </Label>
        <Input
          id="org-name"
          autoFocus
          placeholder="Acme Inc."
          disabled={submitting}
          aria-invalid={errors.name ? "true" : undefined}
          {...register("name")}
        />
        {errors.name ? (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label
          htmlFor="org-slug"
          className="text-xs uppercase tracking-wide text-[var(--text-muted)]"
        >
          URL slug
        </Label>
        <Input
          id="org-slug"
          placeholder="acme"
          disabled={submitting}
          aria-invalid={errors.slug ? "true" : undefined}
          {...register("slug")}
        />
        <p className="text-xs text-muted-foreground">
          Your workspace URL will be{" "}
          <code className="rounded bg-muted px-1">/{slug || "…"}</code>
        </p>
        {errors.slug ? (
          <p className="text-xs text-destructive">{errors.slug.message}</p>
        ) : null}
      </div>

      {errors.root ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errors.root.message}
        </div>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
