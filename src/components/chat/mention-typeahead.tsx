// Re-export the chat mention picker components so non-chat composers
// (work-item comments, notes) can import them without crossing the
// chat-feature folder boundary semantically. The implementation lives
// in mention-picker.tsx; this barrel keeps the import surface clean
// for the note + comment composers (Task G3).
export { MentionPicker, useOrgMembers } from "./mention-picker";
export type { OrgUser } from "./mention-picker";
