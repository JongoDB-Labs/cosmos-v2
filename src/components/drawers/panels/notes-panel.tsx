"use client";

import { NotesList } from "@/components/notes/notes-list";

interface NotesPanelProps {
  orgId: string;
  orgSlug: string;
}

/**
 * Notes drawer tool. Hosts the SAME full component as the /notes page
 * (`NotesList` — search + visibility filters + cards + the Lexical rich-text
 * `NoteEditor`), so the drawer and the page are one and the same experience
 * (no separate plain-markdown editor). The panel just fills the drawer body;
 * the DockedDrawer frame supplies the tool tabs, resize, and close.
 */
export function NotesPanel({ orgId }: NotesPanelProps) {
  return (
    <div className="h-full overflow-y-auto">
      <NotesList orgId={orgId} />
    </div>
  );
}
