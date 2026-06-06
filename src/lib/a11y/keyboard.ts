import type { KeyboardEvent } from "react";

/**
 * Returns an `onKeyDown` handler that fires `handler` on Enter or Space, so a
 * non-native-button element made interactive with `role="button" tabIndex={0}`
 * is keyboard-operable like a real button. Space's default page-scroll is
 * prevented. Pair with a visible `focus-visible:` style so keyboard users can
 * see the focused element.
 */
export function activateOnKey(handler: () => void) {
  return (e: KeyboardEvent) => {
    // Only activate when the element itself is focused — not when the key event
    // bubbled up from an interactive descendant (e.g. a nested button/menu),
    // which would otherwise double-trigger the container's action.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}
