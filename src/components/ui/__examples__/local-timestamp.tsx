import { LocalTimestamp, LocalTime } from "../local-timestamp";

// A fixed instant, so the gallery renders the same thing every visit. 02:15 UTC
// is the previous evening in the Americas — which is the whole point of these
// two components, and visible here if you are reading this west of UTC.
const INSTANT = "2026-07-30T02:15:00.000Z";

export const localTimestampExamples = [
  {
    label: "Timestamp in the reader's zone",
    node: <LocalTimestamp value={INSTANT} />,
    code: `<LocalTimestamp value={activity.createdAt} />`,
  },
  {
    label: "Time only, where the date is already in a group heading",
    node: <LocalTime value={INSTANT} />,
    code: `<LocalTime value={activity.createdAt} />`,
  },
  {
    label: "No timestamp — default fallback",
    node: <LocalTimestamp value={null} />,
    code: `<LocalTimestamp value={key.lastUsed} />`,
  },
  {
    label: "No timestamp — custom fallback",
    node: <LocalTimestamp value={null} fallback="never" />,
    code: `<LocalTimestamp value={key.lastUsed} fallback="never" />`,
  },
];
