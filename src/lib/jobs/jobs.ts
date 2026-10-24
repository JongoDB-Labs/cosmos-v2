import { registerJob } from "./runner";
import { runCalendarPulls } from "@/lib/integrations/microsoft/calendar-sync.server";
import { prisma } from "@/lib/db/client";
import { pruneDomainEvents } from "@/lib/work-items/events.server";
import { drainOutbox } from "@/lib/automation/outbox.server";
import { sendDueDeliveries } from "@/lib/webhooks/deliver.server";
import { sweepAllMarkedComments } from "@/lib/feedback/comments.server";
import { runWorkflowMigrations } from "@/lib/workflow/migrate.server";
import { runDueSubscriptions } from "@/lib/query/subscriptions.server";
import { drainTeamsOutbox, queueChannelDigests, queueDueDigests } from "@/lib/integrations/microsoft/teams-app/notify.server";

/**
 * Every periodic job the app runs, registered on the shared runner
 * (src/lib/jobs/runner.ts). Add one with registerJob({ name, everyMs, run }):
 * the run must be idempotent, since a leader change can repeat a run.
 */

// COSMOS-202 B2: bring Outlook edits back into Cosmos for everyone connected.
registerJob({
  name: "outlook-calendar-pull",
  everyMs: 5 * 60_000,
  jitterMs: 30_000,
  timeoutMs: 4 * 60_000,
  run: async ({ signal }) => {
    const r = await runCalendarPulls({ signal });
    return r.people || r.throttled || r.failed ? { ...r } : undefined;
  },
});

// Workflow: the domain-event outbox keeps EVENT_RETENTION_DAYS of processed
// history. `stuck` (unprocessed for over an hour) should stay 0.
registerJob({
  name: "domain-events-prune",
  everyMs: 6 * 60 * 60_000,
  jitterMs: 10 * 60_000,
  timeoutMs: 10 * 60_000,
  run: async ({ signal }) => {
    const r = await pruneDomainEvents(prisma, { signal });
    return r.deleted || r.stuck ? r : undefined;
  },
});

// Workflow P4: hand committed outbox events to their consumers (webhook
// deliveries are queued here). Every second, so a change reaches a webhook
// within a few seconds; a tick with nothing to do is one indexed query.
registerJob({
  name: "outbox-worker",
  everyMs: 1_000,
  jitterMs: 250,
  timeoutMs: 30_000,
  run: async ({ signal }) => {
    const r = await drainOutbox(prisma, { signal });
    return r.events ? { ...r } : undefined;
  },
});

// Workflow P4: send queued webhook deliveries, retrying failures with backoff.
registerJob({
  name: "webhook-deliveries",
  everyMs: 2_000,
  jitterMs: 500,
  timeoutMs: 60_000,
  run: async ({ signal }) => {
    const r = await sendDueDeliveries(prisma, { signal });
    return r.sent || r.failed ? { ...r } : undefined;
  },
});

// Feedback comment markings: a ceiling change sweeps in its own request, and a
// failure there is only logged. This catches it, so withdrawn notifications
// and internal replies don't wait for the next ceiling write.
registerJob({
  name: "feedback-marking-sweep",
  everyMs: 15 * 60_000,
  jitterMs: 60_000,
  timeoutMs: 10 * 60_000,
  run: async ({ signal }) => {
    const r = await sweepAllMarkedComments({ signal });
    return r.comments ? { ...r } : undefined;
  },
});

// Workflow P3: move items out of statuses a published workflow (or a new
// assignment) dropped, from the map stored with that change. Resumable: the
// work is read from the data on every run. A publish also starts it at once.
registerJob({
  name: "workflow-migrations",
  everyMs: 60_000,
  jitterMs: 10_000,
  timeoutMs: 5 * 60_000,
  run: async ({ signal }) => {
    const r = await runWorkflowMigrations(prisma, { signal });
    return r.moved > 0 ? r : undefined;
  },
});

// CQL phase 6: emailed saved filters. Due rows are claimed with SKIP LOCKED and
// their next run moved on before sending, so a repeated run sends nothing twice.
registerJob({
  name: "filter-subscriptions",
  everyMs: 5 * 60_000,
  jitterMs: 30_000,
  timeoutMs: 4 * 60_000,
  run: async ({ signal }) => {
    const r = await runDueSubscriptions({ signal });
    return r.subscriptions ? { ...r } : undefined;
  },
});

// COSMOS-202 T2: Cosmos for Teams. Channel updates are gathered each minute
// (one card per channel at most), "due tomorrow" hourly, and the outbox is
// drained each minute, each card re-read as its recipient when it's sent.
registerJob({
  name: "teams-channel-digest",
  everyMs: 60_000,
  jitterMs: 5_000,
  timeoutMs: 50_000,
  run: async () => {
    const queued = await queueChannelDigests();
    return queued ? { queued } : undefined;
  },
});

registerJob({
  name: "teams-due-tomorrow",
  everyMs: 60 * 60_000,
  jitterMs: 5 * 60_000,
  timeoutMs: 10 * 60_000,
  run: async () => {
    const queued = await queueDueDigests();
    return queued ? { queued } : undefined;
  },
});

registerJob({
  name: "teams-outbox",
  everyMs: 60_000,
  jitterMs: 5_000,
  timeoutMs: 55_000,
  run: async ({ signal }) => {
    const r = await drainTeamsOutbox({ signal });
    return r.sent || r.retried || r.forgotten || r.dropped ? { ...r } : undefined;
  },
});
