"use client";
import { LoadError } from "../load-error";

export function LoadErrorWithRetry() {
  return (
    <LoadError onRetry={() => window.location.reload()} />
  );
}

export function LoadErrorCustom() {
  return (
    <LoadError
      title="Couldn't load themes"
      description="The theme service didn't respond. Try again in a moment."
      onRetry={() => {}}
    />
  );
}
