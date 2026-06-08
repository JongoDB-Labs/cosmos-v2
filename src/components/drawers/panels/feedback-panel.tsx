"use client";

import { FeedbackPortal } from "@/components/feedback/feedback-portal";

interface FeedbackPanelProps {
  orgId: string;
  orgSlug: string;
}

/**
 * Feedback drawer tool. Hosts the SAME full component as the /feedback page
 * (`FeedbackPortal` — the voteable list of requests/bugs PLUS the submit
 * dialog), not just a submit form, so the drawer and the page are one
 * experience. The DockedDrawer frame supplies the tool tabs, resize, and close.
 */
export function FeedbackPanel({ orgId }: FeedbackPanelProps) {
  return (
    <div className="h-full overflow-y-auto p-4">
      <FeedbackPortal orgId={orgId} />
    </div>
  );
}
