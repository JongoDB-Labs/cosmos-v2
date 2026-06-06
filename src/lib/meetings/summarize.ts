export interface MeetingTicket { title: string; description: string; type: string }
export interface MeetingSummary { summary: string; tickets: MeetingTicket[] }

export function parseSummaryJson(raw: string): MeetingSummary {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model output");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<MeetingSummary>;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    tickets: Array.isArray(parsed.tickets)
      ? parsed.tickets
          .filter((t): t is MeetingTicket => !!t && typeof (t as MeetingTicket).title === "string")
          .map((t) => ({ title: t.title, description: t.description ?? "", type: t.type ?? "TASK" }))
      : [],
  };
}

export const SUMMARY_SYSTEM_PROMPT =
  'You are a meeting analyst. Read the meeting notes and transcript and return STRICT JSON only, ' +
  'no prose outside it: {"summary": "<concise markdown summary>", "tickets": ' +
  '[{"title": "<imperative>", "description": "<context>", "type": "TASK|BUG|STORY"}]}. ' +
  "Extract only concrete action items as tickets.";
