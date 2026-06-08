"use client";

import { AssistantDrawer } from "./assistant-drawer";
import { NotesDrawer } from "./notes-drawer";
import { FeedbackDrawer } from "./feedback-drawer";

interface DrawerHostProps {
  orgId: string | undefined;
  orgSlug: string | undefined;
}

/**
 * Mounts the three global slide-over drawers (Assistant, Notes, Feedback).
 * Rendered once inside the dashboard shell, INSIDE the DrawerProvider.
 *
 * Every drawer needs an org in context (their APIs are org-scoped), so the
 * whole set is gated on a resolved orgId/orgSlug — on `/onboarding`, `/admin`,
 * or an unknown slug nothing mounts and the topbar triggers are simply absent.
 */
export function DrawerHost({ orgId, orgSlug }: DrawerHostProps) {
  if (!orgId || !orgSlug) return null;

  return (
    <>
      <AssistantDrawer orgId={orgId} orgSlug={orgSlug} />
      <NotesDrawer orgId={orgId} />
      <FeedbackDrawer orgId={orgId} />
    </>
  );
}
