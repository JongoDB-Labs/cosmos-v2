/**
 * How late a message may still go out. After the jobs were down (an outage, or
 * the first start on an install where they never ran), they catch up on STATE:
 * every event is processed, status moves and rule state changes still happen.
 * But an email, webhook or notification about something older than this is
 * noise, and a burst of them on recovery is worse: those are skipped and
 * counted, never sent late.
 */
export const SIDE_EFFECT_WINDOW_MS = 60 * 60_000;

/** Is something that happened at `at` too old to send a message about now? */
export const tooLateToSend = (at: Date, now: Date) => now.getTime() - at.getTime() > SIDE_EFFECT_WINDOW_MS;
